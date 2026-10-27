"use server";

import { and, eq, gte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { appointments, availability } from "@/db/schema";
import { availabilitySchema, fieldErrors } from "@/lib/auth";
import { requireRole } from "@/lib/session";
import { clinicNow } from "@/lib/slots";

export type AvailabilityState = {
  error?: string;
  message?: string;
  errors?: Record<string, string>;
} | null;

function revalidateDoctor(doctorId: number) {
  revalidatePath("/dashboard/doctor");
  revalidatePath(`/doctors/${doctorId}`);
}

export async function addAvailability(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  const session = await requireRole("doctor");

  const parsed = availabilitySchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const data = parsed.data;
  const db = getDb();

  const [duplicate] = await db
    .select({ id: availability.id })
    .from(availability)
    .where(
      and(
        eq(availability.doctorId, session.profileId),
        eq(availability.dayOfWeek, data.dayOfWeek),
        eq(availability.startTime, data.startTime),
      ),
    )
    .limit(1);

  if (duplicate) {
    return { error: "You already have a window starting at that time on that day." };
  }

  await db.insert(availability).values({
    doctorId: session.profileId,
    dayOfWeek: data.dayOfWeek,
    startTime: data.startTime,
    endTime: data.endTime,
    slotMinutes: data.slotMinutes,
  });

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
