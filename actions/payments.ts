"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { appointments, payments } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPaymentProvider, PAYMENT_HOLD_MINUTES } from "@/lib/payments";
import { confirmPayment, failPayment } from "@/lib/payments/ledger";
import { releaseExpiredPayments } from "@/lib/payments/expire";

export type CreatePaymentOrderState = {
  error?: string;
  order?: {
    orderId: string;
    amountMinor: number;
    currency: string;
    keyId: string;
    paymentId: number;
  };
} | null;

/**
 * Opens a checkout for a booked appointment.
 *
 * The amount is read from the payment row (which was itself copied from the
 * doctor's consultation fee at booking time) — never from the client. Reusing
 * the existing pending payment keeps retries from creating duplicate ledger
 * rows, and each attempt refreshes the slot hold.
 */
export async function createPaymentOrder(
  _prev: CreatePaymentOrderState,
  formData: FormData,
): Promise<CreatePaymentOrderState> {
  const session = await requireSession();
  if (session.role !== "patient") {
    return { error: "Only patients can pay for appointments." };
  }

  const appointmentId = Number(formData.get("appointmentId"));
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    return { error: "Invalid appointment." };
  }

  const provider = getPaymentProvider();
  const keyId = provider.publicKeyId();
  if (!keyId) {
    return { error: "Online payments are not available. Please pay at the clinic." };
  }

  const db = getDb();
  // Release any abandoned holds first, so a checkout cannot be opened for an
  // appointment whose slot has already been reclaimed.
  await releaseExpiredPayments();

  const [appointment] = await db
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      status: appointments.status,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!appointment) return { error: "Appointment not found." };
  if (appointment.patientId !== session.profileId) {
    return { error: "That appointment does not belong to you." };
  }
  if (appointment.status !== "booked") {
    return { error: "This appointment is not awaiting payment." };
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.appointmentId, appointmentId))
    .limit(1);

  if (!payment) return { error: "No payment record exists for this appointment." };
  if (payment.status === "succeeded") return { error: "This appointment is already paid." };
  if (payment.status === "failed") {
    return { error: "This payment failed. Please pay at the clinic or contact support." };
  }

  // Re-check expiry immediately before charging so an abandoned hold from
  // another tab cannot be resurrected after its slot was released.
  try {
    const order = await provider.createOrder({
      amountMinor: Math.round(Number(payment.amount) * 100),
      currency: payment.currency,
      receipt: `medrella-appt-${appointmentId}`,
      notes: { appointmentId: String(appointmentId), patientId: String(appointment.patientId) },
    });

    const expiresAt = new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000);
    await db
      .update(payments)
      .set({
        provider: provider.name,
        providerOrderId: order.id,
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    revalidatePath("/dashboard/patient");

    return {
      order: {
        orderId: order.id,
        amountMinor: order.amountMinor,
        currency: order.currency,
        keyId,
        paymentId: payment.id,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not start the payment. Please try again.";
    return { error: message };
  }
}

export type ConfirmCheckoutInput = { razorpayPaymentId: string };
export type ConfirmCheckoutResult =
  | { ok: true }
  | { ok: false; error: string; notYet?: boolean };

/** How long to wait for the gateway to settle a capture it accepted but has
 * not yet reported as captured — racing the checkout's close by a few hundred
 * milliseconds is normal. */
const CONFIRM_RECHECKS = 3;
const CONFIRM_RECHECK_WAIT_MS = 700;

/**
 * Looks up the ledger row a gateway payment should land on: first by the exact
 * order id (the normal path), then by the appointment id the payment echoes in
 * its notes, which reconciles a capture made against an order superseded by a
 * re-opened checkout.
 */
async function findLedgerPayment(
  orderId: string,
  appointmentId: number | undefined,
): Promise<typeof payments.$inferSelect | null> {
  const db = getDb();
  const [byOrder] = await db
    .select()
    .from(payments)
    .where(eq(payments.providerOrderId, orderId))
    .limit(1);
  if (byOrder) return byOrder;

  if (appointmentId === undefined || appointmentId <= 0) return null;
  const [reused] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.appointmentId, appointmentId), eq(payments.status, "pending")))
    .limit(1);
  return reused ?? null;
}

function recheckWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Confirms a payment the browser checkout says has succeeded — without
 * trusting the browser: the server asks the gateway about that payment id and
 * only settles the ledger when the gateway reports money actually captured,
 * for the amount the appointment is owed. The success screen is a hint, never
 * the truth. The webhook route (still merged, still signature-checked)
 * becomes a backstop rather than a dependency.
 */
export async function confirmCheckout(
  input: ConfirmCheckoutInput,
): Promise<ConfirmCheckoutResult> {
  const session = await requireSession();
  if (session.role !== "patient") {
    return { ok: false, error: "Only patients can confirm payments." };
  }

  const reference = typeof input?.razorpayPaymentId === "string" ? input.razorpayPaymentId : "";
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(reference)) {
    return { ok: false, error: "The gateway did not return a usable payment reference." };
  }

  const provider = getPaymentProvider();
  if (provider.name === "manual") {
    return { ok: false, error: "Online payments are not configured." };
  }

  let entity = await provider.fetchPayment(reference);
  for (
    let rechecks = 0;
    entity && !entity.captured && entity.status !== "failed" && rechecks < CONFIRM_RECHECKS;
    rechecks += 1
  ) {
    await recheckWait(CONFIRM_RECHECK_WAIT_MS);
    entity = await provider.fetchPayment(reference);
  }

  if (!entity) {
    return {
      ok: false,
      error: "Could not verify the payment with the gateway. Refresh and try again.",
    };
  }

  const notesAppointmentIdRaw = Number(entity.notes?.appointmentId ?? 0);
  const notesAppointmentId =
    Number.isInteger(notesAppointmentIdRaw) && notesAppointmentIdRaw > 0
      ? notesAppointmentIdRaw
      : undefined;

  const payment = await findLedgerPayment(entity.orderId, notesAppointmentId);
  if (!payment) {
    return { ok: false, error: "This payment does not match an appointment in Medrella." };
  }
  if (payment.patientId !== session.profileId) {
    return { ok: false, error: "This payment does not belong to you." };
  }
  if (payment.status === "succeeded") return { ok: true };
  if (payment.status !== "pending") {
    return { ok: false, error: "This appointment's payment is no longer pending." };
  }

  if (entity.status === "failed") {
    await failPayment(
      payment.id,
      payment.appointmentId,
      entity.id,
      entity.errorDescription ?? "payment_failed",
    );
    revalidatePath("/dashboard/patient");
    return { ok: false, error: "The payment failed. You can try again." };
  }

  if (!entity.captured) {
    return {
      ok: false,
      error: "The gateway is still settling the payment — refresh in a few seconds.",
      notYet: true,
    };
  }

  const amountMinor = Math.round(Number(payment.amount) * 100);
  if (entity.amountMinor !== amountMinor || entity.currency !== payment.currency) {
    return {
      ok: false,
      error: "The gateway recorded a different amount for this payment. Refresh and try again.",
    };
  }

  await confirmPayment(payment.id, payment.appointmentId, entity.id);
  revalidatePath("/dashboard/patient");
  return { ok: true };
}
