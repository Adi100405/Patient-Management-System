"use client";

import { PaymentCheckout } from "@/components/payment-checkout";

/**
 * A confirmed booking that still needs online payment.
 *
 * The slot is held by the real booking action; this card only mounts the same
 * Razorpay checkout the patient dashboard already uses, so a failure, dismissal
 * or retry behaves exactly like a booking made on the screen.
 */
export function PaymentCard({
  appointmentId,
  amount,
  currency,
}: {
  appointmentId: number;
  amount: string;
  currency: string;
}) {
  return (
    <div className="rounded-2xl border border-teal-200 bg-teal-50/60 p-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-800">
        Slot held
      </p>
      <p className="mt-0.5 text-sm leading-relaxed text-teal-900">
        Complete the payment to confirm this visit.
      </p>
      <div className="mt-2.5">
        <PaymentCheckout appointmentId={appointmentId} amount={amount} currency={currency} />
      </div>
    </div>
  );
}
