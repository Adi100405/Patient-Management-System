"use server";

import { and, eq, gt, isNotNull, lt, lte, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { appointments, availability, doctors, payments } from "@/db/schema";
import { bookingSchema } from "@/lib/auth";
import { isUniqueViolation } from "@/lib/db-errors";
import { refundLineFor, sendBookingConfirmation, sendCancellationNotice } from "@/lib/notifications/events";
import { getPaymentProvider, PAYMENT_HOLD_MINUTES } from "@/lib/payments";
import { refundForCancellation, type RefundOutcome } from "@/lib/refunds/service";
import { requireSession } from "@/lib/session";
import { availableSlots, clinicClock, clinicNow, dayOfWeekFor } from "@/lib/slots";

export type BookingState = {
  error?: string;
  message?: string;
  appointmentId?: number;
  payment?: { amount: string; currency: string; online: boolean };
} | null;

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
  // Assigned once the appointment insert succeeds, so the caller can open a
  // checkout for it and the response can report the fee that is now due.
  let appointmentId: number | undefined;

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

  const [doctor] = await db
    .select({ fee: doctors.consultationFee })
    .from(doctors)
    .where(eq(doctors.id, data.doctorId))
    .limit(1);

  if (!doctor) {
    return { error: "That doctor is no longer available." };
  }

  const provider = getPaymentProvider();
  const online = provider.publicKeyId() !== null;

  // One unpaid checkout at a time. Without this a single patient could hold
  // several doctors' slots in parallel simply by never finishing payment.
  if (online) {
    const [unpaid] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.patientId, session.profileId),
          eq(payments.status, "pending"),
          isNotNull(payments.expiresAt),
          gt(payments.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (unpaid) {
      return {
        error:
          "You already have a booking awaiting payment. Complete it, or wait for the hold to expire.",
      };
    }
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
    const [appointment] = await db
      .insert(appointments)
      .values({
        patientId: session.profileId,
        doctorId: data.doctorId,
        availabilityId: slotWindow.id,
        appointmentDate: data.date,
        appointmentTime: data.time,
        reason: data.reason,
      })
      .returning({ id: appointments.id });
    appointmentId = appointment.id;

    // Every booking owns exactly one payment row from the moment it exists, so
    // refunds, receipts and history never have to guess what was owed.
    // Online: the slot is held until the webhook settles it. Manual: the fee is
    // collected at the clinic and the appointment stands on its own.
    await db.insert(payments).values({
      appointmentId: appointment.id,
      patientId: session.profileId,
      doctorId: data.doctorId,
      amount: doctor.fee,
      currency: "INR",
      status: "pending",
      provider: provider.name,
      expiresAt: online ? new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000) : null,
    });
  } catch (error) {
    // The partial unique index is the authoritative guard against two patients
    // racing for the same slot between the read above and this insert.
    if (isUniqueViolation(error, "appointments_booked_slot_unique")) {
      return { error: "That slot was just taken. Please choose another time." };
    }
    // Compensate: a booking must never survive without its payment row.
    if (appointmentId !== undefined) {
      await db.delete(appointments).where(eq(appointments.id, appointmentId));
    }
    throw error;
  }

  revalidatePath(`/doctors/${data.doctorId}`);
  revalidatePath("/dashboard/patient");
  revalidatePath("/dashboard/doctor");

  // Notification after the fact, never inside the transactional path: a booking
  // this successful must not fail because an email could not be sent.
  if (appointmentId !== undefined) {
    await sendBookingConfirmation(appointmentId, { online });
  }

  return {
    message: `Booked for ${data.date} at ${data.time}`,
    appointmentId,
    payment: { amount: doctor.fee, currency: "INR", online },
  };
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
  const cancelled = await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(and(eq(appointments.id, id), eq(appointments.status, "booked")))
    .returning({ id: appointments.id });

  // Cancelling also ends any checkout still in flight, so an abandoned Razorpay
  // window cannot later "confirm" a visit the patient already cancelled.
  if (cancelled.length > 0) {
    await db
      .update(payments)
      .set({ status: "failed", failureReason: "cancelled_by_patient", expiresAt: null, updatedAt: new Date() })
      .where(and(eq(payments.appointmentId, id), eq(payments.status, "pending")));

    // Money that was already captured is returned per policy. This is
    // deliberately separate from the cancellation: the visit is cancelled even
    // if the refund cannot be started, and the refund's own status says whether
    // the money has actually moved.
    let refundOutcome: RefundOutcome = { status: "none", reason: "no_refund_due" };
    try {
      refundOutcome = await refundForCancellation({
        appointmentId: id,
        cancelledBy: session.role === "doctor" ? "clinic" : "patient",
      });
    } catch {
      // The refund row records its own failure; nothing to surface here.
    }

    // Told only what is actually true: the policy outcome, never a promise that
    // money is on its way before the gateway has accepted the refund.
    await sendCancellationNotice(id, {
      cancelledBy: session.role === "doctor" ? "clinic" : "patient",
      refundLine: refundLineFor(refundOutcome),
    });
  }

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
