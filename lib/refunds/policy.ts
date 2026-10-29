/**
 * Refund policy. The brief asks for "policy-driven" refunds, so the rules live
 * in one table rather than being scattered through the cancellation code.
 *
 * Tiers are evaluated in order and the first tier whose cut-off the cancellation
 * still meets decides the refund. Change the numbers here and every channel
 * (patient cancel, clinic cancel, retry, receipts) follows automatically.
 */

export type RefundTier = {
  /** Minimum whole hours between the cancellation and the appointment start. */
  minHoursBefore: number;
  /** Percentage of the fee returned at this tier. */
  percentage: number;
  /** Machine-readable reason stored on the refund row. */
  reason: string;
  /** Patient-facing explanation. */
  note: string;
};

export const REFUND_POLICY = {
  currency: "INR",
  tiers: [
    {
      minHoursBefore: 24,
      percentage: 100,
      reason: "cancelled_before_24h",
      note: "Cancelled more than 24 hours before the appointment — full refund.",
    },
    {
      minHoursBefore: 2,
      percentage: 50,
      reason: "cancelled_within_24h",
      note: "Cancelled within 24 hours of the appointment — 50% refund.",
    },
    {
      minHoursBefore: -Infinity,
      percentage: 0,
      reason: "cancelled_within_2h",
      note: "Cancelled within 2 hours of the appointment — no refund.",
    },
  ] as const satisfies readonly RefundTier[],
  /**
   * A cancellation made by the clinic itself is never the patient's fault, so it
   * is always refunded in full regardless of timing.
   */
  clinicCancellationPercentage: 100,
} as const;

export type RefundDecision =
  | { eligible: false; amountMinor: 0; percentage: 0; reason: string; note: string }
  | { eligible: true; amountMinor: number; percentage: number; reason: string; note: string };

/**
 * Decides what a cancellation is owed.
 *
 * `hoursUntilStart` is real elapsed time, negative once the slot has passed, so
 * the same function covers late cancellations and no-shows alike.
 */
export function evaluateRefundPolicy(input: {
  /** Paid amount in minor units (paise). */
  paidMinor: number;
  hoursUntilStart: number;
  cancelledBy: "patient" | "clinic";
}): RefundDecision {
  const tiers = REFUND_POLICY.tiers;
  const tier: RefundTier =
    input.cancelledBy === "clinic"
      ? {
          minHoursBefore: -Infinity,
          percentage: REFUND_POLICY.clinicCancellationPercentage,
          reason: "cancelled_by_clinic",
          note: "Cancelled by the clinic — full refund.",
        }
      : (tiers.find((candidate) => input.hoursUntilStart >= candidate.minHoursBefore) ??
        tiers[tiers.length - 1]);

  const amountMinor = Math.round((input.paidMinor * tier.percentage) / 100);

  if (tier.percentage <= 0 || amountMinor <= 0) {
    return { eligible: false, amountMinor: 0, percentage: 0, reason: tier.reason, note: tier.note };
  }

  return {
    eligible: true,
    amountMinor,
    percentage: tier.percentage,
    reason: tier.reason,
    note: tier.note,
  };
}
