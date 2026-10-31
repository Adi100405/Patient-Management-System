import { mobileChannelName, notify } from "./index";
import { appointmentMailContext } from "./context";
import {
  appointmentCancelled,
  appointmentRescheduled,
  bookingConfirmed,
  paymentConfirmed,
  refundUpdate,
  reminder,
  type AppointmentMailContext,
  type MailContent,
} from "./templates";
import { channelsFor, preferencesForUser } from "./preferences";
import type { NotifyResult } from "./index";
import type { RefundOutcome } from "@/lib/refunds/service";

/**
 * Patient-facing notification events. Every function here is safe to call from
 * inside a transactional flow: a missing appointment, a missing email address
 * or a dead provider all end as a logged no-op, never as a thrown error. A
 * booking must not fail because email is down.
 *
 * Each event renders once into an email and (where a template has one) a short
 * mobile message, then delivers both through the patient's own channel choices
 * — so a patient who has not consented to mobile messages never receives one,
 * and one who has disabled email is not emailed behind their back.
 */

async function contextFor(appointmentId: number) {
  return appointmentMailContext(appointmentId);
}

type DeliveryReport = { email: NotifyResult | null; mobile: NotifyResult | null };

async function deliver(
  ctx: AppointmentMailContext,
  content: MailContent,
  options: { kind: string; idempotencyKey?: string | null },
): Promise<DeliveryReport> {
  const prefs = await preferencesForUser(ctx.patientUserId);
  const plan = channelsFor(prefs, { phone: ctx.patientPhone });

  // One transport carries the short message: WhatsApp once configured, else
  // SMS. The patient consented to "mobile updates", not to a specific network.
  const mobile = mobileChannelName();

  // Per-channel idempotency keys: one ledger row per channel, so a duplicate
  // event can never double-send on either transport.
  const emailKey = options.idempotencyKey ? `${options.idempotencyKey}:email` : null;
  const mobileKey = options.idempotencyKey ? `${options.idempotencyKey}:${mobile}` : null;

  const [email, mobileResult] = await Promise.all([
    plan.email
      ? notify(
          {
            to: ctx.patientEmail,
            subject: content.subject,
            text: content.text,
            html: content.html,
            meta: { kind: options.kind },
          },
          { channel: "email", idempotencyKey: emailKey },
        )
      : Promise.resolve(null),
    plan.sms && content.sms
      ? notify(
          {
            to: ctx.patientPhone ?? "",
            subject: "",
            text: content.sms,
            meta: { kind: options.kind },
          },
          { channel: mobile, idempotencyKey: mobileKey },
        )
      : Promise.resolve(null),
  ]);

  return { email, mobile: mobileResult };
}

export async function sendBookingConfirmation(
  appointmentId: number,
  options: { online: boolean },
) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = bookingConfirmed(ctx, options);
  await deliver(ctx, content, {
    kind: "booking_confirmed",
    idempotencyKey: `booking_confirmed:${appointmentId}`,
  });
}

/** Called after the appointment row already carries the new slot, so the
 * context reads the new time; the old one travels in `options`. */
export async function sendRescheduleNotice(
  appointmentId: number,
  options: { previousDate: string; previousTime: string },
) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = appointmentRescheduled(ctx, options);
  await deliver(ctx, content, {
    kind: "appointment_rescheduled",
    // Moving the same visit to the same slot twice is the same message; the
    // old slot in the key keeps A→B→A distinct from a repeated A→B.
    idempotencyKey: `appointment_rescheduled:${appointmentId}:${options.previousDate}T${options.previousTime}->${ctx.date}T${ctx.time}`,
  });
}

export async function sendPaymentConfirmation(appointmentId: number) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = paymentConfirmed(ctx);
  await deliver(ctx, content, {
    kind: "payment_confirmed",
    idempotencyKey: `payment_confirmed:${appointmentId}`,
  });
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
  await deliver(ctx, content, {
    kind: "appointment_cancelled",
    idempotencyKey: `appointment_cancelled:${appointmentId}`,
  });
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
  await deliver(ctx, content, {
    kind: `refund_${options.stage}`,
    idempotencyKey: `refund_${options.stage}:${appointmentId}`,
  });
}

export async function sendAppointmentReminder(
  appointmentId: number,
  kind: "24h" | "1h",
  /** Set when the send succeeded, so the sweep can store it on the ledger row. */
): Promise<string | null> {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return null;
  const content = reminder(ctx, { kind });
  const report = await deliver(ctx, content, {
    kind: `reminder_${kind}`,
    // Deliberately no idempotency key: the `reminders` table already claims
    // each appointment+kind once, and it must stay possible to re-send after a
    // failed delivery (the notification ledger row is kept for audit only).
  });
  return report.email?.delivered ? ctx.patientEmail : null;
}
