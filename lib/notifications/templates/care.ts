import { renderEmail } from "../email-layout";
import {
  dashboardCta,
  followUpCta,
  greeting,
  signOff,
  visitLine,
  visitRows,
} from "./shared";
import type { AppointmentMailContext, MailContent } from "./shared";

/**
 * The post-visit care loop: a thank-you after the visit, and — only when the
 * doctor advised one — a follow-up prompt some days later.
 *
 * Neither message quotes the doctor's aftercare note. That note is medical
 * content; it lives behind the patient's dashboard, and these messages only
 * point to it. This is the same rule the rest of the templates follow for the
 * patient's free-text reason.
 */

export function visitThanks(
  ctx: AppointmentMailContext,
  options: { hasAftercare: boolean },
): MailContent {
  const nextStep = options.hasAftercare
    ? "Your aftercare instructions are ready on your dashboard whenever you need them."
    : `If anything comes up, you can book a follow-up with Dr. ${ctx.doctorName} from your dashboard.`;

  return {
    subject: `Thanks for visiting Dr. ${ctx.doctorName}`,
    sms: `Medrella: thanks for visiting Dr. ${ctx.doctorName} today. Any aftercare notes are on your dashboard.`,
    text: [
      greeting(ctx),
      `Thank you for visiting Dr. ${ctx.doctorName} (${ctx.specialization}).`,
      "",
      nextStep,
      "",
      visitLine(ctx),
    ].join("\n") + signOff,
    html: renderEmail({
      heading: "Thanks for your visit",
      intro: `Thank you for visiting Dr. ${ctx.doctorName}. ${nextStep}`,
      rows: visitRows(ctx),
      cta: dashboardCta(),
      footnote: "Your visit history and any aftercare stay available on your dashboard.",
    }),
  };
}

export function followUpPrompt(
  ctx: AppointmentMailContext,
  options: { days: number },
): MailContent {
  const cadence =
    options.days === 1
      ? "about a day"
      : options.days % 7 === 0
        ? `about ${options.days / 7} week${options.days === 7 ? "" : "s"}`
        : `about ${options.days} days`;

  return {
    subject: `Follow-up with Dr. ${ctx.doctorName} recommended`,
    sms: `Medrella: Dr. ${ctx.doctorName} recommended a follow-up around now — book when it suits you.`,
    text: [
      greeting(ctx),
      `When you last saw Dr. ${ctx.doctorName}, a follow-up in ${cadence} was recommended — that time has come.`,
      "",
      "You can pick a slot that works for you from the doctor's page.",
    ].join("\n") + signOff,
    html: renderEmail({
      heading: "A follow-up was recommended",
      intro: `When you last saw Dr. ${ctx.doctorName}, a follow-up in ${cadence} was advised — that time has come. Booking takes under a minute.`,
      rows: visitRows(ctx),
      cta: followUpCta(ctx),
      footnote: "This is a suggestion from your doctor, not a confirmed booking.",
    }),
  };
}
