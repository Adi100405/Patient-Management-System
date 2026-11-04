import { formatCurrency, formatDate, formatTime } from "@/lib/utils";
import { renderEmail } from "../email-layout";
import {
  dashboardCta,
  greeting,
  inline,
  paymentCta,
  signOff,
  visitLine,
  visitRows,
} from "./shared";
import type { AppointmentMailContext, MailContent } from "./shared";

/** Messages about a booking itself: made, paid, moved, cancelled, due soon. */

export function bookingConfirmed(
  ctx: AppointmentMailContext,
  options: { online: boolean },
): MailContent {
  const paymentLine = options.online
    ? "Your slot is held for 15 minutes while you complete payment. The booking is confirmed the moment the payment succeeds."
    : `No payment is due now — the consultation fee of ${formatCurrency(ctx.fee)} is payable at the clinic.`;

  return {
    subject: `Appointment booked — ${formatDate(ctx.date)} at ${formatTime(ctx.time)}`,
    sms: `Medrella: appointment booked — ${formatDate(ctx.date)} at ${formatTime(ctx.time)}, Dr. ${ctx.doctorName}. Details: your Medrella dashboard.`,
    text: [
      greeting(ctx),
      "Your appointment is booked.",
      "",
      visitLine(ctx),
      paymentLine,
      "",
      "You can view or cancel it from your dashboard.",
    ].join("\n") + signOff,
    html: renderEmail({
      heading: "Your appointment is booked",
      intro: `Your appointment with Dr. ${ctx.doctorName} is booked. ${paymentLine}`,
      rows: visitRows(ctx, [["Fee", `${formatCurrency(ctx.fee)} ${ctx.currency}`]]),
      cta: dashboardCta(),
      footnote: "You can view or cancel it from your dashboard.",
    }),
  };
}

export function paymentConfirmed(ctx: AppointmentMailContext): MailContent {
  return {
    subject: `Payment received — appointment confirmed`,
    sms: `Medrella: payment of ${formatCurrency(ctx.fee)} received. Your appointment on ${formatDate(ctx.date)} at ${formatTime(ctx.time)} is confirmed.`,
    text: [
      greeting(ctx),
      `We have received your consultation fee of ${formatCurrency(ctx.fee)}. Your appointment is confirmed.`,
      "",
      visitLine(ctx),
      "",
      "A receipt is available from your dashboard.",
    ].join("\n") + signOff,
    html: renderEmail({
      heading: "Payment received",
      intro: `We have received your consultation fee of ${formatCurrency(ctx.fee)}. Your appointment is confirmed.`,
      rows: visitRows(ctx, [["Amount paid", `${formatCurrency(ctx.fee)} ${ctx.currency}`]]),
      cta: paymentCta(ctx),
      footnote: "A printable receipt is available any time from your dashboard.",
    }),
  };
}

/**
 * `refundLine` is written by the caller from the real refund state, so a
 * cancellation email never claims money is on its way before the gateway has
 * accepted the refund. `reasonLine` explains automatic cancellations (expired
 * checkout) that neither party triggered by hand.
 */
export function appointmentCancelled(
  ctx: AppointmentMailContext,
  options: { cancelledBy: "patient" | "clinic"; refundLine: string; reasonLine?: string },
): MailContent {
  const subject =
    options.cancelledBy === "clinic"
      ? `Appointment cancelled by the clinic — ${formatDate(ctx.date)}`
      : `Appointment cancelled — ${formatDate(ctx.date)}`;
  const explanation =
    options.cancelledBy === "clinic"
      ? "The clinic has cancelled your appointment. We apologise for the inconvenience."
      : "Your appointment has been cancelled.";
  const note = inline([options.reasonLine ?? "", options.refundLine].filter(Boolean).join(" "));

  return {
    subject,
    sms:
      options.cancelledBy === "clinic"
        ? `Medrella: your appointment with Dr. ${ctx.doctorName} on ${formatDate(ctx.date)} was cancelled by the clinic. We apologise for the inconvenience.`
        : `Medrella: your appointment with Dr. ${ctx.doctorName} on ${formatDate(ctx.date)} has been cancelled.`,
    text: [
      greeting(ctx),
      explanation,
      "",
      visitLine(ctx),
      options.reasonLine ?? "",
      options.refundLine,
    ]
      .filter(Boolean)
      .join("\n") + signOff,
    html: renderEmail({
      heading: subject,
      intro: explanation,
      rows: visitRows(ctx),
      cta: dashboardCta(),
      footnote: note || undefined,
    }),
  };
}

export function appointmentRescheduled(
  ctx: AppointmentMailContext,
  options: { previousDate: string; previousTime: string },
): MailContent {
  return {
    subject: `Appointment rescheduled — ${formatDate(ctx.date)} at ${formatTime(ctx.time)}`,
    sms: `Medrella: your appointment is moved to ${formatDate(ctx.date)} at ${formatTime(ctx.time)}, Dr. ${ctx.doctorName}. Previous time: ${formatDate(options.previousDate)} ${formatTime(options.previousTime)}.`,
    text: [
      greeting(ctx),
      "Your appointment has been moved to a new time.",
      "",
      `New time: ${visitLine(ctx)}`,
      `Previous time: ${formatDate(options.previousDate)} at ${formatTime(options.previousTime)}`,
      "",
      "Any payment you have already made carries over — no extra charge.",
      "You can view or cancel it from your dashboard.",
    ]
      .filter(Boolean)
      .join("\n") + signOff,
    html: renderEmail({
      heading: "Your appointment has moved",
      intro: `Your appointment with Dr. ${ctx.doctorName} is now on ${formatDate(ctx.date)} at ${formatTime(ctx.time)}.`,
      rows: [
        ["Doctor", `Dr. ${ctx.doctorName}`],
        ["New time", `${formatDate(ctx.date)} at ${formatTime(ctx.time)}`],
        ["Previous time", `${formatDate(options.previousDate)} at ${formatTime(options.previousTime)}`],
      ],
      cta: dashboardCta(),
      footnote: "Any payment you have already made carries over — no extra charge.",
    }),
  };
}

export function reminder(
  ctx: AppointmentMailContext,
  options: { kind: "24h" | "1h" },
): MailContent {
  const when = options.kind === "24h" ? "tomorrow" : "in about an hour";

  return {
    subject: `Reminder — appointment with Dr. ${ctx.doctorName} ${options.kind === "24h" ? "tomorrow" : "in an hour"}`,
    sms: `Medrella: reminder — appointment with Dr. ${ctx.doctorName} ${when} at ${formatTime(ctx.time)}.`,
    text: [
      greeting(ctx),
      options.kind === "24h"
        ? "This is a reminder about your appointment tomorrow."
        : "This is a reminder that your appointment starts in about an hour.",
      "",
      visitLine(ctx),
      "",
      "Need to change it? Cancel from your dashboard — refunds follow the clinic policy.",
    ]
      .filter(Boolean)
      .join("\n") + signOff,
    html: renderEmail({
      heading: `Your appointment is ${options.kind === "24h" ? "tomorrow" : "in about an hour"}`,
      intro: `This is a reminder about your appointment with Dr. ${ctx.doctorName} ${when}.`,
      rows: visitRows(ctx),
      cta: dashboardCta(),
      footnote: "Need to change it? Cancel from your dashboard — refunds follow the clinic policy.",
    }),
  };
}
