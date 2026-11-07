"use server";

import { and, eq, gte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { appointments, availability, availabilityDates } from "@/db/schema";
import { availabilityEditSchema, availabilitySchema, fieldErrors } from "@/lib/auth";
import { blocksForDoctor } from "@/lib/availability";
import { requireRole } from "@/lib/session";
import { clinicNow } from "@/lib/slots";
import {
  blocksConflict,
  elasticEditConflict,
  streamSpacing,
  type BookedTime,
  type ScheduleBlock,
} from "@/lib/schedule";
import { bookedUpcomingForAvailability } from "@/lib/seats";
import { sendWindowChangeNotice } from "@/lib/notifications/events";
import { formatDate } from "@/lib/utils";

export type AvailabilityState = {
  error?: string;
  message?: string;
  errors?: Record<string, string>;
} | null;

function revalidateDoctor(doctorId: number) {
  revalidatePath("/dashboard/doctor");
  revalidatePath(`/doctors/${doctorId}`);
}

/**
 * Publishes a schedule block.
 *
 * A block is weekly or date-based, never both, and it may not cover a clock
 * time another block already covers on the same date: two overlapping blocks
 * would compete for the same seats and the seat numbers would stop meaning
 * anything.
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
 * Removes one availability window. Windows that still hold upcoming bookings are
 * refused so patients are never left with an appointment attached to a deleted slot.
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

/**
 * The busiest a start time gets on any single upcoming date: a weekly block
 * re-runs every week, so the seat floor an edit must respect is the worst day,
 * not the total across days.
 */
function busiestDayPerTime(
  rows: ReadonlyArray<{ date: string; time: string }>,
): BookedTime[] {
  const perDateAndTime = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.date}T${row.time}`;
    perDateAndTime.set(key, (perDateAndTime.get(key) ?? 0) + 1);
  }

  const busiest = new Map<string, number>();
  for (const [key, count] of perDateAndTime) {
    const time = key.split("T")[1]!;
    busiest.set(time, Math.max(busiest.get(time) ?? 0, count));
  }
  return [...busiest].map(([time, seats]) => ({ time, seats }));
}

/**
 * Elastic scheduling: edits a published block's window — shrinking it,
 * expanding it, or changing its capacity — without disturbing a single booked
 * visit.
 *
 * The scheduling type and visit length stay as published; only the bounds and
 * the capacity are elastic. An edit that would strand a booked visit (a wave
 * position no longer offered, a stream start moved, a capacity below what a
 * day already holds) is refused, naming the visit that blocks it. A stream
 * whose end moved under booked visits tells each of those patients.
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

  const current: ScheduleBlock = {
    id: window.id,
    schedulingType: window.schedulingType,
    dayOfWeek: window.dayOfWeek,
    dates: [],
    startTime: window.startTime,
    endTime: window.endTime,
    slotMinutes: window.slotMinutes,
    capacity: window.capacity,
  };

  const candidate: ScheduleBlock = {
    ...current,
    startTime: data.startTime,
    endTime: data.endTime,
    // A stream re-derives its publish-time spacing from the edited window so
    // the stored rules keep round-tripping; bookings never fan out by it.
    slotMinutes:
      window.schedulingType === "wave"
        ? window.slotMinutes
        : streamSpacing(data.startTime, data.endTime, data.capacity),
    capacity: data.capacity,
  };

  // The edit keeps the block's weekday or date list, so a sibling conflict is
  // judged against the same days the block already owns.
  const siblings = (await blocksForDoctor(session.profileId)).filter(
    (block) => block.id !== id,
  );
  if (siblings.some((block) => blocksConflict(candidate, block))) {
    return {
      error: "The edited window would cover time another window already has. Remove the other window first.",
    };
  }

  const bookedRows = await bookedUpcomingForAvailability(id, clinicNow().date);
  const conflict = elasticEditConflict(current, candidate, busiestDayPerTime(bookedRows));
  if (conflict) {
    return { error: conflict };
  }

  await db
    .update(availability)
    .set({
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      slotMinutes: candidate.slotMinutes,
      capacity: candidate.capacity,
    })
    .where(eq(availability.id, id));

  // A stream's bookings span the window, so a moved end changes what every
  // booked patient reads. Waves anchor each visit to its own start, which did
  // not move, so their patients are told nothing.
  const endMoved = window.schedulingType === "stream" && data.endTime !== window.endTime;
  if (endMoved && bookedRows.length > 0) {
    await Promise.all(
      bookedRows.map((row) => sendWindowChangeNotice(row.id, { previousEnd: window.endTime })),
    );
  }

  revalidateDoctor(session.profileId);
  return { message: "Availability updated." };
}
