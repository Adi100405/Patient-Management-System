import { formatCurrency } from "@/lib/utils";
import { renderEmail } from "../email-layout";
import { dashboardCta, greeting, signOff, visitLine, visitRows } from "./shared";
import type { AppointmentMailContext, MailContent } from "./shared";

/**
 * Refund updates. Each stage states what the gateway has actually done — an
 * initiated refund is never described as money already returned.
 */
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

  const heading = `Refund ${options.stage === "completed" ? "completed" : options.stage === "failed" ? "failed" : "initiated"}`;

  return {
    subject: `${heading} — ${amount}`,
    sms: {
      initiated: `Medrella: refund of ${amount} initiated for your cancelled appointment. It usually settles in 3–5 working days.`,
      completed: `Medrella: your refund of ${amount} is complete. It reaches your original payment method in 3–5 working days.`,
      failed: `Medrella: your refund of ${amount} could not be processed right now. We will retry it.`,
    }[options.stage],
    text: [greeting(ctx), ...body, "", visitLine(ctx)].join("\n") + signOff,
    html: renderEmail({
      heading,
      intro: body.join(" "),
      rows: visitRows(ctx, [["Refund amount", amount]]),
      cta: dashboardCta(),
    }),
  };
}
