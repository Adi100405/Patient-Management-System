import { notify } from "./index";
import { appointmentMailContext } from "./context";
import {
  appointmentCancelled,
  bookingConfirmed,
  paymentConfirmed,
  refundUpdate,
  reminder,
} from "./templates";
import type { RefundOutcome } from "@/lib/refunds/service";

/**
 * Patient-facing notification events. Every function here is safe to call from
 * inside a transactional flow: a missing appointment, a missing email address
 * or a dead provider all end as a logged no-op, never as a thrown error. A
 * booking must not fail because email is down.
 */

async function contextFor(appointmentId: number) {
  return appointmentMailContext(appointmentId);
}

export async function sendBookingConfirmation(
  appointmentId: number,
  options: { online: boolean },
) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = bookingConfirmed(ctx, options);
  await notify({ to: ctx.patientEmail, ...content, meta: { kind: "booking_confirmed" } });
}

export async function sendPaymentConfirmation(appointmentId: number) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = paymentConfirmed(ctx);
  await notify({ to: ctx.patientEmail, ...content, meta: { kind: "payment_confirmed" } });
}

/**
 * Turns a refund outcome into the one honest sentence the cancellation email is
 * allowed to say. Nothing here ever claims money is returning before the
 * gateway has accepted the refund.
 */
export function refundLineFor(outcome: RefundOutcome): string {
  switch (outcome.status) {
    case "created":
      return `\nA refund of ₹${Number(outcome.amount).toFixed(0)} is being processed by the payment gateway — you will receive a separate email once it completes.`;
    case "existing":
      return "\nYour refund for this appointment is already being processed.";
    case "failed":
      return "\nA refund was due for this appointment but could not be started. Our team has been notified and it will be retried.";
    case "none":
    default:
      switch (outcome.reason) {
        case "cancelled_before_24h":
        case "cancelled_within_24h":
          return "\nYour refund is being processed by the payment gateway.";
        case "cancelled_within_2h":
          return "\nThis cancellation is within 2 hours of the appointment, so the clinic refund policy does not return the fee.";
        case "payment_pending":
        case "payment_failed":
          return "\nNo payment had been captured, so there is nothing to refund.";
        default:
          return "\nNo refund applies to this cancellation.";
      }
  }
}

export async function sendCancellationNotice(
  appointmentId: number,
  options: { cancelledBy: "patient" | "clinic"; refundLine: string; reasonLine?: string },
) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = appointmentCancelled(ctx, options);
  await notify({ to: ctx.patientEmail, ...content, meta: { kind: "appointment_cancelled" } });
}

export async function sendRefundUpdate(
  appointmentId: number,
  options: {
    stage: "initiated" | "completed" | "failed";
    amount: string;
    currency: string;
    detail?: string;
  },
) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = refundUpdate(ctx, options);
  await notify({ to: ctx.patientEmail, ...content, meta: { kind: `refund_${options.stage}` } });
}

export async function sendAppointmentReminder(
  appointmentId: number,
  kind: "24h" | "1h",
  /** Set when the send succeeded, so the sweep can store it on the ledger row. */
): Promise<string | null> {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return null;
  const content = reminder(ctx, { kind });
  const delivered = await notify({
    to: ctx.patientEmail,
    ...content,
    meta: { kind: `reminder_${kind}` },
  });
  return delivered ? ctx.patientEmail : null;
}
