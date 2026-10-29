"use client";

import { useActionState } from "react";
import { retryRefund, type RetryRefundState } from "@/actions/refunds";

/**
 * Retries a refund the gateway rejected. Kept small and inline so a patient can
 * recover without contacting support, while the server action re-checks
 * ownership and refund state before anything is resubmitted.
 */
export function RetryRefundButton({ refundId }: { refundId: number }) {
  const [state, formAction, pending] = useActionState<RetryRefundState, FormData>(retryRefund, null);

  if (state?.message) {
    return <span className="text-xs text-slate-600">{state.message}</span>;
  }

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="refundId" value={refundId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-teal-700 underline-offset-2 hover:underline disabled:text-slate-400"
      >
        {pending ? "Retrying…" : "Retry refund"}
      </button>
      {state?.error && <span className="text-xs text-rose-600">{state.error}</span>}
    </form>
  );
}
