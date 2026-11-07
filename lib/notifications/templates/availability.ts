import { visitWhenLabel } from "@/lib/schedule";
import { formatDate } from "@/lib/utils";
import { renderEmail } from "../email-layout";
import { dashboardCta, greeting, signOff, visitRows, whenSuffix } from "./shared";
import type { AppointmentMailContext, MailContent } from "./shared";

/** Messages about the schedule around a booking: the window a visit sits in. */

/**
 * A stream window's end moved — shrunk or expanded by the doctor — while the
 * patient's booking kept its start and its place in the queue.
 *
 * Called after the block row already carries the new end, so the context reads
 * the new window; the old end travels in `options`. A booked stream's start
 * cannot move (the edit is refused), so both ranges share their start.
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
