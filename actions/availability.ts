"use server";

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  BOOKED_SEAT_INDEX,
  appointments,
  availability,
  availabilityDates,
  scheduleChangeMoves,
  scheduleChanges,
} from "@/db/schema";
import { availabilityEditSchema, availabilitySchema, fieldErrors } from "@/lib/auth";
import { blocksForDoctor } from "@/lib/availability";
import { isUniqueViolation } from "@/lib/db-errors";
import {
  planDisplacement,
  type DisplacementPlacement,
  type DisplacementReason,
} from "@/lib/displacement";
import { sendClinicMoveNotice, sendNeedsRebookingNotice, sendWindowChangeNotice } from "@/lib/notifications/events";
import { blocksConflict, streamSpacing, windowIsClosed, type ScheduleBlock } from "@/lib/schedule";
import { bookedUpcomingForDoctor } from "@/lib/seats";
import { requireRole } from "@/lib/session";
import { clinicNow } from "@/lib/slots";
import { formatDate } from "@/lib/utils";

export type AvailabilityPreviewRow = {
  readonly appointmentId: number;
  readonly patientName: string;
  readonly outcome: "retimed" | "moved" | "needs_rebooking";
  readonly fromDate: string;
  readonly fromTime: string;
  readonly toDate: string | null;
  readonly toTime: string | null;
  readonly reason: DisplacementReason;
};

export type AvailabilityPreview = {
  readonly summary: string;
  readonly closed: boolean;
  readonly affectedCount: number;
  readonly retimedCount: number;
  readonly movedCount: number;
  readonly needsRebookingCount: number;
  /** Visits already underway; they stay where they are whatever the edit. */
  readonly lockedCount: number;
  readonly rows: readonly AvailabilityPreviewRow[];
};

export type AvailabilityState = {
  error?: string;
  message?: string;
  errors?: Record<string, string>;
  preview?: AvailabilityPreview;
} | null;

function revalidateDoctor(doctorId: number) {
  revalidatePath("/dashboard/doctor");
  revalidatePath("/dashboard/patient");
  revalidatePath(`/doctors/${doctorId}`);
}

/**
 * Publishes a schedule block.
 *
 * A block is weekly or date-based, never both, and it may not cover a clock
 * time another block already covers on the same date: two overlapping blocks
 * would compete for the same seats and the seat numbers would stop meaning
 * anything. An equal start and end is allowed: the block is published as
 * closed and offers no slots.
 */
export async function addAvailability(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  const session = await requireRole("doctor");

  const parsed = availabilitySchema.safeParse({
    ...Object.fromEntries(formData.entries()),
    dates: formData.getAll("dates").map(String),
  });
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const data = parsed.data;
  const db = getDb();

  // A dated block on a day that has already gone would never be bookable, so
  // it is refused rather than quietly published as dead availability.
  const today = clinicNow().date;
  const pastDate = data.dates.find((date) => date < today);
  if (pastDate) {
    return {
      error: `${formatDate(pastDate)} has already passed. Pick today or a later date.`,
    };
  }

  const candidate: ScheduleBlock = {
    id: -1,
    schedulingType: data.schedulingType,
    dayOfWeek: data.recurrence === "weekly" ? (data.dayOfWeek ?? null) : null,
    dates: data.recurrence === "dates" ? data.dates : [],
    startTime: data.startTime,
    endTime: data.endTime,
    // A stream has no visit length of its own: the distance between its
    // positions is the window divided by the capacity.
    slotMinutes:
      data.schedulingType === "wave"
        ? (data.slotMinutes ?? 30)
        : streamSpacing(data.startTime, data.endTime, data.capacity),
    capacity: data.capacity,
  };

  const existing = await blocksForDoctor(session.profileId);
  if (existing.some((block) => blocksConflict(candidate, block))) {
    return {
      error: "You already cover that time on that day. Remove the other window first.",
    };
  }

  const [created] = await db
    .insert(availability)
    .values({
      doctorId: session.profileId,
      schedulingType: candidate.schedulingType,
      dayOfWeek: candidate.dayOfWeek,
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      slotMinutes: candidate.slotMinutes,
      capacity: candidate.capacity,
    })
    .returning({ id: availability.id });

  if (candidate.dates.length > 0) {
    await db.insert(availabilityDates).values(
      candidate.dates.map((date) => ({ availabilityId: created!.id, date })),
    );
  }

  revalidateDoctor(session.profileId);
  return { message: "Availability added." };
}

/**
 * Removes one availability window. Windows that still hold upcoming bookings
 * are refused so patients are never left with an appointment attached to a
 * deleted slot. Closing a window is the elastic alternative: it keeps history
 * and displaces its live bookings safely.
 */
export async function removeAvailability(formData: FormData) {
  const session = await requireRole("doctor");

  const id = Number(formData.get("availabilityId"));
  if (!Number.isInteger(id) || id <= 0) return;

  const db = getDb();
  const [window] = await db
    .select()
    .from(availability)
    .where(eq(availability.id, id))
    .limit(1);

  if (!window || window.doctorId !== session.profileId) return;

  const [upcoming] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.availabilityId, id),
        eq(appointments.status, "booked"),
        gte(appointments.appointmentDate, clinicNow().date),
      ),
    );

  if ((upcoming?.count ?? 0) > 0) return;

  await db.delete(availability).where(eq(availability.id, id));

  revalidateDoctor(session.profileId);
}

async function loadCurrentBlock(
  window: typeof availability.$inferSelect,
): Promise<ScheduleBlock> {
  const db = getDb();
  const dates = await db
    .select({ date: availabilityDates.date })
    .from(availabilityDates)
    .where(eq(availabilityDates.availabilityId, window.id));

  return {
    id: window.id,
    schedulingType: window.schedulingType,
    dayOfWeek: window.dayOfWeek,
    // The dated list is part of the block's identity. Loading it here keeps
    // the sibling-overlap check judging the days the block actually owns.
    dates: dates.map((row) => row.date),
    startTime: window.startTime,
    endTime: window.endTime,
    slotMinutes: window.slotMinutes,
    capacity: window.capacity,
  };
}

function candidateFrom(
  current: ScheduleBlock,
  data: {
    startTime: string;
    endTime: string;
    capacity: number;
  },
): ScheduleBlock {
  return {
    ...current,
    startTime: data.startTime,
    endTime: data.endTime,
    // A stream re-derives its publish-time spacing from the edited window so
    // the stored rules keep round-tripping; bookings never fan out by it.
    slotMinutes:
      current.schedulingType === "wave"
        ? current.slotMinutes
        : streamSpacing(data.startTime, data.endTime, data.capacity),
    capacity: data.capacity,
  };
}

function previewFor(input: {
  candidate: ScheduleBlock;
  rows: ReadonlyMap<number, { patientName: string }>;
  placements: readonly DisplacementPlacement[];
}): AvailabilityPreview {
  const changed = input.placements.filter(
    (placement) =>
      placement.outcome === "retimed" ||
      placement.outcome === "moved" ||
      placement.outcome === "needs_rebooking",
  );

  const rows: AvailabilityPreviewRow[] = changed.map((placement) => ({
    appointmentId: placement.appointmentId,
    patientName: input.rows.get(placement.appointmentId)?.patientName ?? "Patient",
    outcome: placement.outcome as AvailabilityPreviewRow["outcome"],
    fromDate: placement.from.date,
    fromTime: placement.from.time,
    toDate: placement.to?.date ?? null,
    toTime: placement.to?.time ?? null,
    reason: placement.reason as DisplacementReason,
  }));

  const retimedCount = rows.filter((row) => row.outcome === "retimed").length;
  const movedCount = rows.filter((row) => row.outcome === "moved").length;
  const needsRebookingCount = rows.filter((row) => row.outcome === "needs_rebooking").length;
  const lockedCount = input.placements.filter(
    (placement) => placement.outcome === "locked",
  ).length;
  const closed = windowIsClosed(input.candidate);

  return {
    summary: summaryFor({ closed, retimedCount, movedCount, needsRebookingCount, lockedCount }),
    closed,
    affectedCount: rows.length,
    retimedCount,
    movedCount,
    needsRebookingCount,
    lockedCount,
    rows,
  };
}

function summaryFor(input: {
  closed: boolean;
  retimedCount: number;
  movedCount: number;
  needsRebookingCount: number;
  lockedCount: number;
}) {
  const lockedLine =
    input.lockedCount > 0
      ? ` ${input.lockedCount} ${input.lockedCount === 1 ? "visit has" : "visits have"} already started and ${input.lockedCount === 1 ? "stays" : "stay"} in place.`
      : "";

  if (
    input.retimedCount === 0 &&
    input.movedCount === 0 &&
    input.needsRebookingCount === 0
  ) {
    if (input.closed) {
      return input.lockedCount > 0
        ? `This window will close.${lockedLine}`
        : "This window will close. No live bookings are inside it.";
    }
    return input.lockedCount > 0
      ? `No live bookings change.${lockedLine}`
      : "No live bookings are affected by this edit.";
  }

  const parts: string[] = [];
  if (input.retimedCount > 0) {
    parts.push(
      `${input.retimedCount} ${input.retimedCount === 1 ? "visit keeps its place and moves" : "visits keep their places and move"} with the window's new start`,
    );
  }
  if (input.movedCount > 0) {
    parts.push(
      `${input.movedCount} ${input.movedCount === 1 ? "visit is" : "visits are"} moved to another slot`,
    );
  }
  if (input.needsRebookingCount > 0) {
    parts.push(
      `${input.needsRebookingCount} ${input.needsRebookingCount === 1 ? "visit needs" : "visits need"} a new booking`,
    );
  }

  return `${parts.join("; ")}. The clinic's change is binding; each patient can keep it, reschedule or cancel.${lockedLine}`;
}

/**
 * Elastic scheduling: edits a published block's window — shrinking it,
 * expanding it, moving its start, closing it — without ever letting a booked
 * visit block the change.
 *
 * The form submits twice. The first submit (`mode=preview`) returns the exact
 * impact without writing anything. The second (`mode=apply`) recomputes that
 * impact against fresh data and applies it: the block changes, the oldest
 * bookings keep their places, displaced patients are moved into remaining
 * capacity (same day first, then the next seven days), and anyone with nowhere
 * to go becomes `needs_rebooking`. Every changed visit is written to the
 * schedule audit and notified.
 */
export async function updateAvailability(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  const session = await requireRole("doctor");

  const db = getDb();
  const id = Number(formData.get("availabilityId"));
  if (!Number.isInteger(id) || id <= 0) {
    return { error: "Unknown availability window." };
  }

  const [window] = await db
    .select()
    .from(availability)
    .where(eq(availability.id, id))
    .limit(1);

  if (!window || window.doctorId !== session.profileId) {
    return { error: "Unknown availability window." };
  }

  const parsed = availabilityEditSchema(window.schedulingType).safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }
  const data = parsed.data;

  const current = await loadCurrentBlock(window);
  const candidate = candidateFrom(current, data);

  // The edit keeps the block's weekday or date list, so a sibling conflict is
  // judged against the same days the block already owns.
  const blocks = await blocksForDoctor(session.profileId);
  const siblings = blocks.filter((block) => block.id !== id);
  if (siblings.some((block) => blocksConflict(candidate, block))) {
    return {
      error: "The edited window would cover time another window already has. Remove the other window first.",
    };
  }

  const instant = new Date();
  const now = clinicNow(instant);
  const bookedRows = await bookedUpcomingForDoctor(session.profileId, now.date);
  const plan = planDisplacement({
    candidate,
    blocks,
    bookings: bookedRows.map((row) => ({
      id: row.id,
      availabilityId: row.availabilityId,
      date: row.date,
      time: row.time,
      seatNumber: row.seatNumber,
      queueSince: row.queueSince,
    })),
    now,
  });

  if (formData.get("mode") !== "apply") {
    return {
      preview: previewFor({
        candidate,
        rows: new Map(bookedRows.map((row) => [row.id, { patientName: row.patientName }])),
        placements: plan.placements,
      }),
    };
  }

  const [change] = await db
    .insert(scheduleChanges)
    .values({
      doctorId: session.profileId,
      availabilityId: id,
      previousStartTime: current.startTime,
      previousEndTime: current.endTime,
      previousCapacity: current.capacity,
      nextStartTime: candidate.startTime,
      nextEndTime: candidate.endTime,
      nextCapacity: candidate.capacity,
    })
    .returning({ id: scheduleChanges.id });

  await db
    .update(availability)
    .set({
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      slotMinutes: candidate.slotMinutes,
      capacity: candidate.capacity,
    })
    .where(eq(availability.id, id));

  const changed = plan.placements.filter(
    (placement) =>
      placement.outcome === "retimed" ||
      placement.outcome === "moved" ||
      placement.outcome === "needs_rebooking",
  );

  // Free every displaced seat before reassigning any of them. The partial seat
  // index only covers `booked`, so parking a row in `needs_rebooking` makes its
  // old seat available without inventing a temporary negative seat number
  // (which the seat check constraint would refuse).
  const freedIds = changed
    .filter(
      (placement) =>
        placement.outcome === "moved" || placement.outcome === "needs_rebooking",
    )
    .map((placement) => placement.appointmentId);

  const parked = new Set<number>();
  if (freedIds.length > 0) {
    const rows = await db
      .update(appointments)
      .set({ status: "needs_rebooking", clinicMoved: true })
      .where(
        and(
          inArray(appointments.id, freedIds),
          eq(appointments.status, "booked"),
        ),
      )
      .returning({ id: appointments.id });
    for (const row of rows) parked.add(row.id);
  }

  // Record what actually happened, not what the plan predicted. A patient may
  // cancel between the preview and the apply, or take one of the fallback seats
  // in a parallel booking, and the audit and notices must tell the truth.
  const applied: {
    readonly placement: DisplacementPlacement;
    readonly outcome: "retimed" | "moved" | "needs_rebooking";
  }[] = [];

  for (const placement of changed) {
    if (placement.outcome === "retimed" && placement.to) {
      const rows = await db
        .update(appointments)
        .set({
          appointmentDate: placement.to.date,
          appointmentTime: placement.to.time,
          availabilityId: placement.to.availabilityId,
          clinicMoved: true,
        })
        .where(
          and(
            eq(appointments.id, placement.appointmentId),
            eq(appointments.status, "booked"),
          ),
        )
        .returning({ id: appointments.id });
      if (rows.length > 0) {
        applied.push({ placement, outcome: "retimed" });
      }
      continue;
    }

    if (placement.outcome === "needs_rebooking") {
      // Only a row this apply actually parked is a real displacement; one that
      // was cancelled in the meantime is left out of the audit entirely.
      if (parked.has(placement.appointmentId)) {
        applied.push({ placement, outcome: "needs_rebooking" });
      }
      continue;
    }

    if (placement.outcome === "moved" && placement.to) {
      try {
        const rows = await db
          .update(appointments)
          .set({
            appointmentDate: placement.to.date,
            appointmentTime: placement.to.time,
            availabilityId: placement.to.availabilityId,
            seatNumber: placement.to.seatNumber,
            status: "booked",
            clinicMoved: true,
          })
          .where(
            and(
              eq(appointments.id, placement.appointmentId),
              eq(appointments.status, "needs_rebooking"),
            ),
          )
          .returning({ id: appointments.id });
        if (rows.length > 0) {
          applied.push({ placement, outcome: "moved" });
        }
      } catch (error) {
        if (!isUniqueViolation(error, BOOKED_SEAT_INDEX)) throw error;

        // Someone else took the fallback seat after the plan was computed. The
        // row is already parked, so it simply stays parked and the patient is
        // asked to choose a time instead of the whole edit failing.
        applied.push({ placement, outcome: "needs_rebooking" });
      }
    }
  }

  if (applied.length > 0) {
    await db.insert(scheduleChangeMoves).values(
      applied.map(({ placement, outcome }) => ({
        changeId: change!.id,
        appointmentId: placement.appointmentId,
        // A retimed visit is still a move: its slot changed with the window.
        outcome: outcome === "needs_rebooking" ? ("needs_rebooking" as const) : ("moved" as const),
        reason: placement.reason as DisplacementReason,
        fromDate: placement.from.date,
        fromTime: placement.from.time,
        fromSeatNumber: placement.from.seatNumber,
        toAvailabilityId:
          outcome === "needs_rebooking" ? null : (placement.to?.availabilityId ?? null),
        toDate: outcome === "needs_rebooking" ? null : (placement.to?.date ?? null),
        toTime: outcome === "needs_rebooking" ? null : (placement.to?.time ?? null),
        toSeatNumber:
          outcome === "needs_rebooking" ? null : (placement.to?.seatNumber ?? null),
      })),
    );
  }

  // Notifications follow the writes, never the other way round. A provider
  // outage must not leave the schedule changed but its audit missing.
  const endMoved =
    window.schedulingType === "stream" && candidate.endTime !== current.endTime;

  // A visit that did not move still needs to hear that its stream window's end
  // changed — but only if it is still live. One cancelled between the plan and
  // here must not receive a notice about a visit it no longer has.
  const windowNoticeIds = endMoved
    ? plan.placements
        .filter(
          (placement) =>
            placement.outcome === "stayed" || placement.outcome === "locked",
        )
        .map((placement) => placement.appointmentId)
    : [];
  const liveNoticeIds =
    windowNoticeIds.length > 0
      ? new Set(
          (
            await db
              .select({ id: appointments.id })
              .from(appointments)
              .where(
                and(
                  inArray(appointments.id, windowNoticeIds),
                  eq(appointments.status, "booked"),
                ),
              )
          ).map((row) => row.id),
        )
      : new Set<number>();

  await Promise.allSettled([
    ...applied.map(({ placement, outcome }) => {
      if (outcome === "needs_rebooking") {
        return sendNeedsRebookingNotice(placement.appointmentId, {
          previousDate: placement.from.date,
          previousTime: placement.from.time,
        });
      }
      return sendClinicMoveNotice(placement.appointmentId, {
        previousDate: placement.from.date,
        previousTime: placement.from.time,
        reason: placement.reason as DisplacementReason,
      });
    }),
    // A stream whose end moved but whose live visits did not (the start stayed
    // put) keeps the original "window changed" notice.
    ...(endMoved
      ? windowNoticeIds
          .filter((appointmentId) => liveNoticeIds.has(appointmentId))
          .map((appointmentId) =>
            sendWindowChangeNotice(appointmentId, {
              previousEnd: current.endTime,
            }),
          )
      : []),
  ]);

  revalidateDoctor(session.profileId);

  const moved = applied.filter((row) => row.outcome === "moved").length;
  const retimed = applied.filter((row) => row.outcome === "retimed").length;
  const needs = applied.filter((row) => row.outcome === "needs_rebooking").length;
  const detail =
    moved + retimed + needs === 0
      ? "Availability updated."
      : `Availability updated. ${moved} moved, ${retimed} retimed, ${needs} need rebooking.`;

  return { message: detail };
}
