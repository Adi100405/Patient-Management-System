"use server";

import { and, eq, gt, isNotNull, lt, lte, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { BOOKED_SEAT_INDEX, appointments, doctors, payments, visitNotes } from "@/db/schema";
import { bookingSchema } from "@/lib/auth";
import { blocksForDoctor } from "@/lib/availability";
import { isUniqueViolation } from "@/lib/db-errors";
import { refundLineFor, sendBookingConfirmation, sendCancellationNotice, sendRescheduleNotice } from "@/lib/notifications/events";
import { getPaymentProvider, PAYMENT_HOLD_MINUTES } from "@/lib/payments";
import { refundForCancellation, type RefundOutcome } from "@/lib/refunds/service";
import { takenSeatNumbers } from "@/lib/seats";
import { requireSession } from "@/lib/session";
import { normalizeAftercare, normalizeFollowUpDays } from "@/lib/visit-notes";
import {
  blockAppliesOn,
  positionsFor,
  seatFor,
  slotHasStarted,
  type Position,
  type ScheduleBlock,
} from "@/lib/schedule";
import { clinicClock, clinicNow, slotArrived } from "@/lib/slots";
import { formatDate, formatTime } from "@/lib/utils";

export type BookingState = {
  error?: string;
  message?: string;
  appointmentId?: number;
  payment?: { amount: string; currency: string; online: boolean };
} | null;

/**
 * How many times a booking tries to take a seat before giving up.
 *
 * The seat index is the authority: a patient who loses the race for seat one
 * re-reads the taken seats and takes the next free one, so two patients racing
 * for a three-patient wave both succeed instead of one being told the slot was
 * taken.
 */
const MAX_SEAT_ATTEMPTS = 3;

/**
 * Books a slot, taking one of its seats.
 *
 * The slot must belong to a published block that is open on that date, and the
 * time must be one of the block's own positions. The seat is chosen from the
 * seats still free, and the database's unique index has the final say — if
 * another patient took the seat first, the booking takes the next one.
 */
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

  const blocks = await blocksForDoctor(data.doctorId);
  const slotWindow = blocks.find((block) => block.id === data.availabilityId);
  if (!slotWindow) {
    return { error: "That availability window is no longer offered." };
  }

  if (!blockAppliesOn(slotWindow, data.date)) {
    return { error: "The doctor does not consult on that day." };
  }

  const position = positionsFor(slotWindow).find((slot) => slot.time === data.time);
  if (!position) {
    return { error: "That time is not one of this doctor's published slots." };
  }

  if (slotHasStarted(data.date, data.time, clinicNow())) {
    return { error: "That slot has already started." };
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

  for (let attempt = 1; attempt <= MAX_SEAT_ATTEMPTS; attempt += 1) {
    const taken = await takenSeatNumbers({
      doctorId: data.doctorId,
      date: data.date,
      time: data.time,
    });
    const seat = seatFor(taken, position.seats);

    if (seat === null) {
      return { error: "That slot is full." };
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
          seatNumber: seat,
          reason: data.reason,
        })
        .returning({ id: appointments.id });
      appointmentId = appointment.id;
      break;
    } catch (error) {
      // Another patient took this seat between the read and this write. The
      // index refused the write, so the booking takes the next free seat.
      if (!isUniqueViolation(error, BOOKED_SEAT_INDEX)) throw error;
    }
  }

  if (appointmentId === undefined) {
    return { error: "That slot was just taken. Please choose another time." };
  }

  try {
    // Every booking owns exactly one payment row from the moment it exists, so
    // refunds, receipts and history never have to guess what was owed.
    // Online: the slot is held until the webhook settles it. Manual: the fee is
    // collected at the clinic and the appointment stands on its own.
    await db.insert(payments).values({
      appointmentId,
      patientId: session.profileId,
      doctorId: data.doctorId,
      amount: doctor.fee,
      currency: "INR",
      status: "pending",
      provider: provider.name,
      expiresAt: online ? new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000) : null,
    });
  } catch (error) {
    // Compensate: a booking must never survive without its payment row.
    await db.delete(appointments).where(eq(appointments.id, appointmentId));
    throw error;
  }

  revalidatePath(`/doctors/${data.doctorId}`);
  revalidatePath("/dashboard/patient");
  revalidatePath("/dashboard/doctor");

  // Notification after the fact, never inside the transactional path: a booking
  // this successful must not fail because an email could not be sent.
  await sendBookingConfirmation(appointmentId, { online });

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

  // Aftercare is recorded only for a completed visit, and only once the status
  // transition has succeeded — a no-show leaves no care note behind.
  if (intent.data === "complete") {
    const aftercare = normalizeAftercare(formData.get("aftercare"));
    const followUpDays = normalizeFollowUpDays(formData.get("followUpDays"));
    await db
      .insert(visitNotes)
      .values({ appointmentId: id, aftercare, followUpDays })
      .onConflictDoUpdate({
        target: visitNotes.appointmentId,
        set: { aftercare, followUpDays, updatedAt: new Date() },
      });
  }

  revalidatePath("/dashboard/doctor");
  revalidatePath("/dashboard/patient");
  revalidatePath(`/doctors/${session.profileId}`);

  return null;
}

export type RescheduleState = { error?: string; message?: string } | null;

/**
 * Moves a booked appointment to a new slot with the same doctor.
 *
 * The patient owns the move: same ownership and status rules as cancellation,
 * and the new slot must be a real, free, future slot of that doctor's published
 * availability. The database's unique booked-slot index is the final arbiter —
 * two patients racing for the same free slot cannot both win, and the loser is
 * told the truth ("that slot was just taken") rather than being silently
 * ignored.
 *
 * Payment and refund handling: the consultation fee does not change with the
 * slot, so a captured payment simply follows the appointment — nothing to
 * charge and nothing to refund. A checkout still in flight keeps its hold: the
 * payment row points at the appointment, not at a slot.
 */
export async function rescheduleAppointment(
  _prev: RescheduleState,
  formData: FormData,
): Promise<RescheduleState> {
  const session = await requireSession();
  if (session.role !== "patient") {
    return { error: "Only patients can reschedule appointments." };
  }

  const id = Number(formData.get("appointmentId"));
  const rawDate = formData.get("date");
  const rawTime = formData.get("time");
  const date = typeof rawDate === "string" ? rawDate : "";
  const time = typeof rawTime === "string" ? rawTime : "";
  if (!Number.isInteger(id) || id <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return { error: "That request could not be understood." };
  }

  const db = getDb();
  const [appointment] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, id))
    .limit(1);

  if (!appointment) return { error: "Appointment not found." };
  if (appointment.patientId !== session.profileId) {
    return { error: "That appointment does not belong to you." };
  }
  if (appointment.status !== "booked") {
    return { error: "Only booked appointments can be rescheduled." };
  }
  if (appointment.appointmentDate === date && appointment.appointmentTime === time) {
    return { error: "That is already your current slot." };
  }
  if (slotArrived(date, time)) {
    return { error: "Pick a slot in the future." };
  }

  // The new slot must come from the doctor's published availability, exactly
  // like a fresh booking — a reschedule cannot invent consulting hours.
  const blocks = await blocksForDoctor(appointment.doctorId);
  const matches: { block: ScheduleBlock; position: Position }[] = [];
  for (const block of blocks) {
    if (!blockAppliesOn(block, date)) continue;
    const position = positionsFor(block).find((slot) => slot.time === time);
    if (position) matches.push({ block, position });
  }

  const match = matches.at(0);
  if (!match) {
    return { error: "The doctor does not offer that time. Pick another slot." };
  }

  const previousDate = appointment.appointmentDate;
  const previousTime = appointment.appointmentTime;

  let moved = false;
  for (let attempt = 1; attempt <= MAX_SEAT_ATTEMPTS; attempt += 1) {
    // The appointment's own seat is not a competitor for itself.
    const taken = await takenSeatNumbers({
      doctorId: appointment.doctorId,
      date,
      time,
      exceptAppointmentId: appointment.id,
    });
    const seat = seatFor(taken, match.position.seats);

    if (seat === null) {
      return { error: "That slot is full. Pick another time." };
    }

    try {
      const updated = await db
        .update(appointments)
        .set({
          appointmentDate: date,
          appointmentTime: time,
          availabilityId: match.block.id,
          seatNumber: seat,
        })
        .where(and(eq(appointments.id, id), eq(appointments.status, "booked")))
        .returning({ id: appointments.id });

      if (updated.length === 0) {
        return { error: "That appointment is no longer bookable." };
      }

      moved = true;
      break;
    } catch (error) {
      // Someone else took the seat between our check and this write. The index
      // refused the move; the appointment is untouched, so take the next seat.
      if (!isUniqueViolation(error, BOOKED_SEAT_INDEX)) throw error;
    }
  }

  if (!moved) {
    return { error: "That slot was just taken. Pick another time." };
  }

  revalidatePath("/dashboard/patient");
  revalidatePath("/dashboard/doctor");
  revalidatePath(`/doctors/${appointment.doctorId}`);

  // Reminders need no cleanup: the sweep reads live state, so the moved slot's
  // reminders fire at the new time and the old ones never fire at all.
  await sendRescheduleNotice(id, { previousDate, previousTime });

  return {
    message: `Rescheduled to ${formatDate(date)} at ${formatTime(time)}`,
  };
}
