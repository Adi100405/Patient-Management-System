import { notify } from "./index";
import { appointmentMailContext } from "./context";
import {
  appointmentCancelled,
  appointmentClinicMoved,
  appointmentNeedsRebooking,
  appointmentRescheduled,
  appointmentWindowChanged,
  bookingConfirmed,
  followUpPrompt,
  passwordChanged,
  passwordResetRequest,
  paymentConfirmed,
  refundUpdate,
  reminder,
  visitThanks,
  type AppointmentMailContext,
  type MailContent,
} from "./templates";
import { channelsFor, preferencesForUser } from "./preferences";
import type { NotifyResult } from "./index";
import type { DisplacementReason } from "@/lib/displacement";
import type { RefundOutcome } from "@/lib/refunds/service";
import { hashResetToken } from "@/lib/password";

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

/**
 * Where a multi-channel send actually landed, for the sweep's ledger.
 *
 * Email is preferred as the record, but a patient who turned email off and kept
 * mobile on was still reached — reporting null there would delete the sweep's
 * claim and re-send the same mobile message on every run.
 */
export function deliveredTo(ctx: AppointmentMailContext, report: DeliveryReport): string | null {
  if (report.email?.delivered) return ctx.patientEmail;
  if (report.mobile?.delivered && ctx.patientPhone) return ctx.patientPhone;
  return null;
}

async function deliver(
  ctx: AppointmentMailContext,
  content: MailContent,
  options: { kind: string; idempotencyKey?: string | null },
): Promise<DeliveryReport> {
  const prefs = await preferencesForUser(ctx.patientUserId);
  const plan = channelsFor(prefs, { phone: ctx.patientPhone });

  // One transport carries the short message: SMS. WhatsApp was a second mobile
  // channel until it was removed — it needs a Meta-approved template, and the
  // only template this project could use was a fixed one that ignored the
  // appointment date, so a booking could have gone out with the wrong day on
  // it. SMS carries the real text instead.
  const mobile = "sms";

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

/**
 * A stream window's end moved under a booked visit. Called after the block row
 * already carries the new end, so the context reads the new window; the old
 * end travels in `options`. Only sent when the end actually changed — a start
 * or capacity edit never moves the patient's visit.
 */
export async function sendWindowChangeNotice(
  appointmentId: number,
  options: { previousEnd: string },
) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = appointmentWindowChanged(ctx, options);
  await deliver(ctx, content, {
    kind: "appointment_window_changed",
    // The old and new ends in the key keep shrinking-then-expanding distinct
    // from a repeated edit, the same way the reschedule key carries both slots.
    idempotencyKey: `appointment_window_changed:${appointmentId}:${options.previousEnd}->${ctx.visitEndTime}`,
  });
}

/**
 * The clinic moved a displaced visit into a new published slot. Sent after the
 * appointment row carries its new date and time; the old slot travels in
 * `options`. The message names the change as the clinic's, but preserves the
 * patient's keep / reschedule / cancel choices.
 */
export async function sendClinicMoveNotice(
  appointmentId: number,
  options: {
    previousDate: string;
    previousTime: string;
    reason: DisplacementReason;
  },
) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = appointmentClinicMoved(ctx, options);
  await deliver(ctx, content, {
    kind: "appointment_clinic_moved",
    // Old and new slots both appear in the key, so an A→B→A sequence is two
    // real moves rather than one duplicate message.
    idempotencyKey: `appointment_clinic_moved:${appointmentId}:${options.previousDate}T${options.previousTime}->${ctx.date}T${ctx.time}`,
  });
}

/** The clinic could not place a displaced visit inside the rebooking horizon. */
export async function sendNeedsRebookingNotice(
  appointmentId: number,
  options: { previousDate: string; previousTime: string },
) {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return;
  const content = appointmentNeedsRebooking(ctx, options);
  await deliver(ctx, content, {
    kind: "appointment_needs_rebooking",
    idempotencyKey: `appointment_needs_rebooking:${appointmentId}:${options.previousDate}T${options.previousTime}`,
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
  return deliveredTo(ctx, report);
}

/**
 * Post-visit thank-you, sent shortly after a completed visit. `hasAftercare`
 * only decides whether the message points at the doctor's aftercare note; the
 * note itself is never included.
 */
export async function sendVisitThanks(
  appointmentId: number,
  options: { hasAftercare: boolean },
): Promise<string | null> {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return null;
  const content = visitThanks(ctx, options);
  const report = await deliver(ctx, content, {
    kind: "visit_thanks",
    // No idempotency key: the `care_follow_ups` table owns dedup for this event.
  });
  return deliveredTo(ctx, report);
}

/**
 * Follow-up prompt, sent once `days` have passed since a visit whose doctor
 * recommended one. The calendar decision lives in the sweep; this only renders
 * and delivers.
 */
export async function sendFollowUpPrompt(
  appointmentId: number,
  options: { days: number },
): Promise<string | null> {
  const ctx = await contextFor(appointmentId);
  if (!ctx) return null;
  const content = followUpPrompt(ctx, options);
  const report = await deliver(ctx, content, {
    kind: "follow_up_prompt",
    // No idempotency key: the `care_follow_ups` table owns dedup for this event.
  });
  return deliveredTo(ctx, report);
}

/**
 * Account-security emails. There is no appointment context to look up and no
 * channel preference to honour: a reset link must reach the inbox even when
 * the patient has switched email updates off, and the password-changed
 * heads-up is the tamper alarm, not a preference. Both ride the same ledger
 * (kinds `password_reset` / `password_changed`) for audit and are email-only.
 *
 * The expiry is every reset email's own truth: RESET_TOKEN_TTL_MINUTES just
 * passed in, so the message cannot quietly promise a different lifetime than
 * `lib/password.ts` enforces.
 */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  options: { expiryMinutes: number },
): Promise<NotifyResult> {
  const content = passwordResetRequest({ resetUrl, expiryMinutes: options.expiryMinutes });

  return notify(
    {
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      meta: { kind: "password_reset" },
    },
    {
      channel: "email",
      // Each mint is a distinct credential, so a fresh request mails again;
      // the digest keeps the raw link out of a second column.
      idempotencyKey: `password_reset:${hashResetToken(resetUrl)}`,
    },
  );
}

export async function sendPasswordChangedEmail(to: string): Promise<NotifyResult> {
  const content = passwordChanged();

  return notify(
    {
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      meta: { kind: "password_changed" },
    },
    // Deliberately no idempotency key: every real password change is its own
    // event, and the single-use token claim already prevents one change from
    // mailing twice. The daily sweep retries a failed row on its own.
    { channel: "email" },
  );
}
