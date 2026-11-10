import type { DisplacementReason } from "@/lib/displacement";
import { visitWhenLabel } from "@/lib/schedule";
import { formatDate, formatTime } from "@/lib/utils";
import { renderEmail } from "../email-layout";
import { dashboardCta, greeting, signOff, visitRows, whenSuffix } from "./shared";
import type { AppointmentMailContext, MailContent } from "./shared";

/** Messages about the schedule around a booking: the window a visit sits in. */

/**
 * The doctor changed the published schedule and the clinic moved this visit.
 * The change is binding, but the patient keeps the three real choices: keep the
 * new slot, reschedule it, or cancel it (a clinic-moved cancellation refunds in
 * full).
 */
export function appointmentClinicMoved(
  ctx: AppointmentMailContext,
  options: {
    previousDate: string;
    previousTime: string;
    reason: DisplacementReason;
  },
): MailContent {
  const previousWhen = `${formatDate(options.previousDate)} at ${formatTime(options.previousTime)}`;
  const reason = reasonLine(options.reason);

  return {
    subject: `Your appointment was moved by the clinic — ${formatDate(ctx.date)} at ${whenSuffix(ctx)}`,
    sms: `Medrella: the clinic moved your appointment with Dr. ${ctx.doctorName} to ${formatDate(ctx.date)} at ${whenSuffix(ctx)}. Previous: ${previousWhen}. View, reschedule or cancel it from your dashboard.`,
    text: [
      greeting(ctx),
      reason,
      "",
      `New appointment: ${formatDate(ctx.date)} at ${whenSuffix(ctx)} with Dr. ${ctx.doctorName}`,
      `Previous appointment: ${previousWhen}`,
      "",
      "The clinic's change is binding, but you can keep it, reschedule it, or cancel it from your dashboard.",
      "If you cancel a clinic-moved appointment, the consultation fee is refunded in full.",
    ].join("\n") + signOff,
    html: renderEmail({
      heading: "Your appointment has been moved",
      intro: reason,
      rows: visitRows(ctx, [["Previous appointment", previousWhen]]),
      cta: dashboardCta(),
      footnote:
        "The clinic's change is binding, but you can keep it, reschedule it, or cancel it. A cancellation of a clinic-moved visit is refunded in full.",
    }),
  };
}

/**
 * The clinic could not fit the displaced visit into any remaining slot within
 * its rebooking horizon. The patient is not left without a path: they can pick
 * a new time themselves, and cancelling still refunds in full.
 */
export function appointmentNeedsRebooking(
  ctx: AppointmentMailContext,
  options: { previousDate: string; previousTime: string },
): MailContent {
  const previousWhen = `${formatDate(options.previousDate)} at ${formatTime(options.previousTime)}`;

  return {
    subject: `Please choose a new time — ${formatDate(options.previousDate)}`,
    sms: `Medrella: the clinic could not fit your appointment with Dr. ${ctx.doctorName} into another slot. Please pick a new time from your dashboard. Cancelling is refunded in full.`,
    text: [
      greeting(ctx),
      "The clinic has changed its schedule, and your visit could not be moved into another slot within the next seven days.",
      "",
      `Previous appointment: ${previousWhen} with Dr. ${ctx.doctorName}`,
      "",
      "Please choose a new time from your dashboard.",
      "Your payment is safe. If you cancel instead, the consultation fee is refunded in full because the clinic moved the visit.",
    ].join("\n") + signOff,
    html: renderEmail({
      heading: "Please choose a new time",
      intro:
        "The clinic has changed its schedule, and your visit could not be moved into another slot within the next seven days.",
      rows: [
        ["Doctor", `Dr. ${ctx.doctorName}`],
        ["Specialty", ctx.specialization],
        ["Previous appointment", previousWhen],
      ],
      cta: dashboardCta(),
      footnote:
        "Please choose a new time from your dashboard. Your payment is safe; cancelling a clinic-moved appointment refunds the fee in full.",
    }),
  };
}

function reasonLine(reason: DisplacementReason) {
  switch (reason) {
    case "capacity":
      return "Your doctor reduced the number of patients this schedule window can hold, so your visit was moved to the next available time.";
    case "slot_removed":
      return "Your doctor changed the shape of this schedule window, so your visit was moved to the next available time.";
    case "window_closed":
      return "Your doctor closed this schedule window, so your visit was moved to the next available time.";
    case "start_moved":
      return "Your doctor moved this schedule window's start, so your visit was moved with it.";
  }
}

/**
 * A stream window's end moved — shrunk or expanded by the doctor — while the
 * patient's booking kept its start and its place in the queue.
 *
 * Called after the block row already carries the new end, so the context reads
 * the new window; the old end travels in `options`. A start move retimes every
 * not-started booking and sends them the clinic-move notice instead, so this
 * lighter message only reaches visits whose start stayed put.
 */
export function appointmentWindowChanged(
  ctx: AppointmentMailContext,
  options: { previousEnd: string },
): MailContent {
  const previousWhen = visitWhenLabel({
    schedulingType: ctx.schedulingType,
    time: ctx.time,
    windowEnd: options.previousEnd,
  });

  return {
    subject: `Visit window changed — ${formatDate(ctx.date)}`,
    sms: `Medrella: your visit with Dr. ${ctx.doctorName} on ${formatDate(ctx.date)} now runs ${whenSuffix(ctx)} (previously ${previousWhen}). Your place in the queue is unchanged.`,
    text: [
      greeting(ctx),
      "Your doctor has adjusted the visit window your appointment sits in.",
      "",
      `New window: ${formatDate(ctx.date)} at ${whenSuffix(ctx)}`,
      `Previous window: ${formatDate(ctx.date)} at ${previousWhen}`,
      "",
      "Your appointment date, start time and place in the queue are unchanged — only the window's end has moved.",
      "You can view the appointment from your dashboard.",
    ]
      .join("\n") + signOff,
    html: renderEmail({
      heading: "Your visit window has changed",
      intro: `Your doctor has adjusted the visit window your appointment with Dr. ${ctx.doctorName} sits in.`,
      rows: visitRows(ctx, [
        ["New window", whenSuffix(ctx)],
        ["Previous window", previousWhen],
      ]),
      cta: dashboardCta(),
      footnote:
        "Your appointment date, start time and place in the queue are unchanged — only the window's end has moved.",
    }),
  };
}
