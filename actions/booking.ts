"use server";

import { and, eq, lt, lte, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { appointments, availability } from "@/db/schema";
import { bookingSchema } from "@/lib/auth";
import { isUniqueViolation } from "@/lib/db-errors";
import { requireSession } from "@/lib/session";
import { availableSlots, clinicClock, clinicNow, dayOfWeekFor } from "@/lib/slots";

export type BookingState = { error?: string; message?: string } | null;

export async function bookAppointment(
  _prev: BookingState,
  formData: FormData,
): Promise<BookingState> {
  const session = await requireSession();
  if (session.role !== "patient") {
    return { error: "Only patients can book appointments." };
  }

  const parsed = bookingSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "Please pick a valid date and time." };
  }

  const data = parsed.data;
  const db = getDb();

  const [slotWindow] = await db
    .select()
    .from(availability)
    .where(and(eq(availability.id, data.availabilityId), eq(availability.doctorId, data.doctorId)))
    .limit(1);

  if (!slotWindow || !slotWindow.isActive) {
    return { error: "That availability window is no longer offered." };
  }

  if (slotWindow.dayOfWeek !== dayOfWeekFor(data.date)) {
    return { error: "The doctor does not consult on that day." };
  }

  const booked = await db
    .select({ time: appointments.appointmentTime })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, data.doctorId),
        eq(appointments.appointmentDate, data.date),
        eq(appointments.status, "booked"),
      ),
    );

  const open = availableSlots({
    windows: [slotWindow],
    date: data.date,
    bookedTimes: booked.map((b) => b.time),
  });

  if (!open.includes(data.time)) {
    return { error: "That slot was just taken. Please choose another time." };
  }

  try {
    await db.insert(appointments).values({
      patientId: session.profileId,
      doctorId: data.doctorId,
      availabilityId: slotWindow.id,
      appointmentDate: data.date,
      appointmentTime: data.time,
      reason: data.reason,
    });
  } catch (error) {
    // The partial unique index is the authoritative guard against two patients
    // racing for the same slot between the read above and this insert.
    if (isUniqueViolation(error, "appointments_booked_slot_unique")) {
      return { error: "That slot was just taken. Please choose another time." };
    }
    throw error;
  }

  revalidatePath(`/doctors/${data.doctorId}`);
  revalidatePath("/dashboard/patient");
  revalidatePath("/dashboard/doctor");

  return { message: `Booked for ${data.date} at ${data.time}` };
}

export async function cancelAppointment(formData: FormData) {
  const session = await requireSession();
  const id = Number(formData.get("appointmentId"));
  if (!Number.isInteger(id) || id <= 0) return;

  const db = getDb();
  const [appointment] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, id))
    .limit(1);

  if (!appointment) return;

  const ownsIt =
    session.role === "patient"
      ? appointment.patientId === session.profileId
      : appointment.doctorId === session.profileId;

  if (!ownsIt || appointment.status !== "booked") return;

  // The status guard makes the transition atomic: a visit that was completed
  // or already cancelled a moment ago can never be overwritten by this update.
  await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(and(eq(appointments.id, id), eq(appointments.status, "booked")));

  revalidatePath("/dashboard/patient");
  revalidatePath("/dashboard/doctor");
  revalidatePath(`/doctors/${appointment.doctorId}`);
}

const resolveIntentSchema = z.enum(["complete", "no_show"]);
const resolveStatus = { complete: "completed", no_show: "no_show" } as const;

export type ResolveState = { error?: string } | null;

/**
 * Records the outcome of a visit that has taken place: completed or a no-show.
 * Only the slot's doctor can resolve it, and the WHERE clause refuses to touch
 * appointments whose slot has not arrived yet (clinic time), so a future
 * booking can never be resolved early. Doctor-owned and status conditions live
 * in the same UPDATE, making the transition atomic against concurrent cancels.
 */
export async function resolveAppointment(
  _prev: ResolveState,
  formData: FormData,
): Promise<ResolveState> {
  const session = await requireSession();
  if (session.role !== "doctor") {
    return { error: "Only doctors can record visit outcomes." };
  }

  const intent = resolveIntentSchema.safeParse(formData.get("intent"));
  const id = Number(formData.get("appointmentId"));
  if (!intent.success || !Number.isInteger(id) || id <= 0) {
    return { error: "That request could not be understood." };
  }

  const db = getDb();
  // One instant for both the date and the clock, so they can never disagree
  // if the clinic day flips between the two reads.
  const instant = new Date();
  const now = clinicNow(instant);

  const updated = await db
    .update(appointments)
    .set({ status: resolveStatus[intent.data] })
    .where(
      and(
        eq(appointments.id, id),
        eq(appointments.doctorId, session.profileId),
        eq(appointments.status, "booked"),
        or(
          lt(appointments.appointmentDate, now.date),
          and(
            eq(appointments.appointmentDate, now.date),
            lte(appointments.appointmentTime, clinicClock(instant)),
          ),
        ),
      ),
    )
    .returning({ id: appointments.id });

  if (updated.length === 0) {
    // Diagnose the miss so the doctor sees why, instead of a silent no-op.
    const [appointment] = await db
      .select({ status: appointments.status })
      .from(appointments)
      .where(
        and(eq(appointments.id, id), eq(appointments.doctorId, session.profileId)),
      )
      .limit(1);

    if (!appointment) return { error: "That appointment was not found." };
    if (appointment.status !== "booked") {
      return { error: "That appointment has already been resolved." };
    }
    return { error: "That visit has not taken place yet." };
  }

  revalidatePath("/dashboard/doctor");
  revalidatePath("/dashboard/patient");
  revalidatePath(`/doctors/${session.profileId}`);

  return null;
}
