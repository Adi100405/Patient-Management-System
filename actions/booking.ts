"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { appointments, availability } from "@/db/schema";
import { bookingSchema } from "@/lib/auth";
import { requireSession } from "@/lib/session";
import { availableSlots, dayOfWeekFor } from "@/lib/slots";

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

  await db.insert(appointments).values({
    patientId: session.profileId,
    doctorId: data.doctorId,
    availabilityId: slotWindow.id,
    appointmentDate: data.date,
    appointmentTime: data.time,
    reason: data.reason,
  });

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

  await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, id));

  revalidatePath("/dashboard/patient");
  revalidatePath("/dashboard/doctor");
  revalidatePath(`/doctors/${appointment.doctorId}`);
}
