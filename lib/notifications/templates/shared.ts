import { formatDate, formatTime } from "@/lib/utils";
import type { EmailCta, EmailDetailRow } from "../email-layout";
import { dashboardUrl, receiptUrl } from "../links";

/**
 * The vocabulary every patient message shares: the context a template reads,
 * the shape it returns, and the small builders (a personalised greeting, the
 * doctor/visit detail rows, the standard buttons) that keep the wording of all
 * of them consistent.
 *
 * Templates are pure — no database, no clock, no sending — so every sentence a
 * patient can receive is reviewable in one place and testable in isolation.
 */

export type AppointmentMailContext = {
  appointmentId: number;
  patientName: string;
  patientEmail: string;
  patientPhone: string | null;
  patientUserId: number;
  doctorName: string;
  specialization: string;
  /** Clinic wall-clock date and time of the visit. */
  date: string;
  time: string;
  reason: string | null;
  fee: string;
  currency: string;
  /** Newest settled payment for this visit, or null when nothing was captured. */
  paymentId: number | null;
};

/**
 * One message, three renderings. `sms` is optional because some messages only
 * make sense with room to breathe — but when present it must stay short, and
 * none of the renderings may quote the patient's free-text reason, which is
 * medical content and does not belong in an inbox or a phone's message list.
 */
export type MailContent = { subject: string; text: string; html: string; sms?: string };

export function greeting(ctx: AppointmentMailContext) {
  return `Hi ${ctx.patientName},`;
}

/** The one-line visit summary used inside plain-text bodies. */
export function visitLine(ctx: AppointmentMailContext) {
  return `Dr. ${ctx.doctorName} (${ctx.specialization}) · ${formatDate(ctx.date)} at ${formatTime(ctx.time)}`;
}

/** The visit details as a key/value grid for the HTML layout. */
export function visitRows(
  ctx: AppointmentMailContext,
  extra: readonly EmailDetailRow[] = [],
): readonly EmailDetailRow[] {
  return [
    ["Doctor", `Dr. ${ctx.doctorName}`],
    ["Specialty", ctx.specialization],
    ["When", `${formatDate(ctx.date)} at ${formatTime(ctx.time)}`],
    ...extra,
  ];
}

export function dashboardCta(): EmailCta {
  return { label: "View my appointments", url: dashboardUrl() };
}

/** Payment confirmations land on the receipt itself when one exists. */
export function paymentCta(ctx: AppointmentMailContext): EmailCta {
  return ctx.paymentId !== null
    ? { label: "View receipt", url: receiptUrl(ctx.paymentId) }
    : dashboardCta();
}

/** Refund/reason sentences arrive with leading newlines for the text body. */
export function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const signOff = "\n\n— Medrella Clinic";
