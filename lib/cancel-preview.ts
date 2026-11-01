import { evaluateRefundPolicy } from "@/lib/refunds/policy";
import { hoursUntilSlot } from "@/lib/slots";
import { formatCurrency } from "@/lib/utils";

/**
 * What cancelling this appointment will actually mean, phrased for the confirm
 * dialog *before* the patient commits. It reuses the real refund policy so the
 * dialog can never promise something the cancellation would not honour.
 *
 * It describes the policy outcome, not a completed refund — money is only ever
 * "returned" by the gateway, after the cancellation runs.
 */
export type CancelPreview = {
  /** 100 = full, 50 = partial, 0 = none, null = nothing was captured. */
  percentage: number | null;
  headline: string;
  detail: string;
};

export function describeCancellation(input: {
  paymentStatus: string | null;
  paymentProvider: string | null;
  amount: string | number | null;
  date: string;
  time: string;
  cancelledBy?: "patient" | "clinic";
  now?: Date;
}): CancelPreview {
  if (input.paymentStatus === "refunded") {
    return {
      percentage: null,
      headline: "Already refunded in full",
      detail: "This visit has already been refunded, so there is nothing further to return.",
    };
  }

  const captured =
    input.paymentStatus === "succeeded" || input.paymentStatus === "partially_refunded";

  if (!captured) {
    if (input.paymentProvider === "manual") {
      return {
        percentage: null,
        headline: "Nothing to refund",
        detail: "The fee is payable at the clinic and has not been charged.",
      };
    }
    return {
      percentage: null,
      headline: "No payment captured",
      detail: "This booking is still awaiting payment, so cancelling simply frees the slot.",
    };
  }

  const paidMinor = Math.round(Number(input.amount ?? 0) * 100);
  const decision = evaluateRefundPolicy({
    paidMinor,
    hoursUntilStart: hoursUntilSlot(input.date, input.time, input.now),
    cancelledBy: input.cancelledBy ?? "patient",
  });
  const amount = formatCurrency(decision.amountMinor / 100);

  if (decision.percentage >= 100) {
    return {
      percentage: 100,
      headline: `Full refund — ${amount}`,
      detail:
        (input.cancelledBy ?? "patient") === "clinic"
          ? "Cancelled by the clinic, so the whole fee is returned to the patient's original payment method."
          : "More than 24 hours before your appointment, so the whole fee is returned to your original payment method.",
    };
  }
  if (decision.percentage > 0) {
    return {
      percentage: decision.percentage,
      headline: `${decision.percentage}% refund — ${amount}`,
      detail: "Within 24 hours of your appointment, so part of the fee is returned to your original payment method.",
    };
  }
  return {
    percentage: 0,
    headline: "No refund",
    detail: "This is within 2 hours of your appointment, so the clinic policy does not return the fee.",
  };
}
