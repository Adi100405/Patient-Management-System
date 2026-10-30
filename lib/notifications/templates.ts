import { formatCurrency, formatDate, formatTime } from "@/lib/utils";

/**
 * Pure email templates. No database, no clock, no sending — just text. That
 * makes the wording of every patient-facing message reviewable in one place and
 * trivially testable.
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
};

/**
 * One message, two renderings. `sms` is optional because some templates only
 * make sense with room to breathe — but when present it must stay short, and
 * neither rendering may quote the patient's free-text reason, which is medical
 * content and does not belong in an inbox or a phone's message list.
 */
export type MailContent = { subject: string; text: string; sms?: string };

function greeting(ctx: AppointmentMailContext) {
  return `Hi ${ctx.patientName},`;
}

function visitLine(ctx: AppointmentMailContext) {
  return `Dr. ${ctx.doctorName} (${ctx.specialization}) · ${formatDate(ctx.date)} at ${formatTime(ctx.time)}`;
}

const signOff = "\n\n— Medrella Clinic";

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

  return {
    subject,
    sms:
      options.cancelledBy === "clinic"
        ? `Medrella: your appointment with Dr. ${ctx.doctorName} on ${formatDate(ctx.date)} was cancelled by the clinic. We apologise for the inconvenience.`
        : `Medrella: your appointment with Dr. ${ctx.doctorName} on ${formatDate(ctx.date)} has been cancelled.`,
    text: [
      greeting(ctx),
      options.cancelledBy === "clinic"
        ? "The clinic has cancelled your appointment. We apologise for the inconvenience."
        : "Your appointment has been cancelled.",
      "",
      visitLine(ctx),
      options.reasonLine ?? "",
      options.refundLine,
    ]
      .filter(Boolean)
      .join("\n") + signOff,
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
  };
}

export function reminder(
  ctx: AppointmentMailContext,
  options: { kind: "24h" | "1h" },
): MailContent {
  return {
    subject: `Reminder — appointment with Dr. ${ctx.doctorName} ${options.kind === "24h" ? "tomorrow" : "in an hour"}`,
    sms: `Medrella: reminder — appointment with Dr. ${ctx.doctorName} ${options.kind === "24h" ? "tomorrow" : "in about an hour"} at ${formatTime(ctx.time)}.`,
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
  };
}

export function refundUpdate(
  ctx: AppointmentMailContext,
  options: {
    stage: "initiated" | "completed" | "failed";
    amount: string;
    currency: string;
  },
): MailContent {
  const amount = `${formatCurrency(options.amount)} ${options.currency}`;

  const body = {
    initiated: [
      `A refund of ${amount} has been initiated for your cancelled appointment.`,
      "It is being processed by the payment gateway and typically settles within 3–5 working days. You will get another email once it completes.",
    ],
    completed: [
      `Your refund of ${amount} has been completed by the payment gateway.`,
      "It will appear on your original payment method within 3–5 working days, depending on your bank.",
    ],
    failed: [
      `Your refund of ${amount} could not be processed right now.`,
      "The payment gateway rejected the request. We will retry, and you can also retry it from your dashboard.",
    ],
  }[options.stage];

  return {
    subject: `Refund ${options.stage === "completed" ? "completed" : options.stage === "failed" ? "failed" : "initiated"} — ${amount}`,
    sms: {
      initiated: `Medrella: refund of ${amount} initiated for your cancelled appointment. It usually settles in 3–5 working days.`,
      completed: `Medrella: your refund of ${amount} is complete. It reaches your original payment method in 3–5 working days.`,
      failed: `Medrella: your refund of ${amount} could not be processed right now. We will retry it.`,
    }[options.stage],
    text: [greeting(ctx), ...body, "", visitLine(ctx)].join("\n") + signOff,
  };
}
