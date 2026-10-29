import { RetryRefundButton } from "@/components/retry-refund";
import type { RefundRecord } from "@/lib/refunds/queries";

const copy: Record<RefundRecord["status"], (amount: string) => string> = {
  pending: (amount) => `Refund of ${amount} queued`,
  processing: (amount) => `Refund of ${amount} processing`,
  completed: (amount) => `Refund of ${amount} completed`,
  failed: (amount) => `Refund of ${amount} could not be completed`,
};

const tone: Record<RefundRecord["status"], string> = {
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  processing: "bg-amber-50 text-amber-800 ring-amber-200",
  completed: "bg-teal-50 text-teal-800 ring-teal-200",
  failed: "bg-rose-50 text-rose-800 ring-rose-200",
};

/**
 * Patient-facing refund state. Deliberately worded so a cancelled appointment
 * never reads as "money returned" until the gateway actually confirms it.
 */
export function RefundStatusLine({ refunds }: { refunds: RefundRecord[] }) {
  const latest = refunds[0];
  if (!latest) return null;

  const amount = `₹${Number(latest.amount).toFixed(0)}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone[latest.status]}`}>
        {copy[latest.status](amount)}
      </span>
      {latest.status === "failed" && <RetryRefundButton refundId={latest.id} />}
    </div>
  );
}
