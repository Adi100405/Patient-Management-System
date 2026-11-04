"use server";

import { and, eq, gte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { appointments, availability, availabilityDates } from "@/db/schema";
import { availabilitySchema, fieldErrors } from "@/lib/auth";
import { blocksForDoctor } from "@/lib/availability";
import { requireRole } from "@/lib/session";
import { clinicNow } from "@/lib/slots";
import { blocksConflict, streamSpacing, type ScheduleBlock } from "@/lib/schedule";

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
