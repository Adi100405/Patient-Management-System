"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  confirmCheckout,
  createPaymentOrder,
  type ConfirmCheckoutResult,
  type CreatePaymentOrderState,
} from "@/actions/payments";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CheckCircle2, CreditCard } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  handler: (response: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => void;
  modal?: { ondismiss?: () => void; escape?: boolean };
  theme?: { color?: string };
};

type RazorpayInstance = { open: () => void; on: (event: string, cb: () => void) => void };

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

/**
 * Loads the gateway script once and reports when the global constructor is
 * usable. Polling survives the give-up timeout, so a script that took an
 * unusually long time is still adopted when it finally lands; `retry()` lets a
 * patient re-arm everything after a blocked load without a full page refresh.
 */
function useCheckoutScript(): { ready: boolean; failed: boolean; retry: () => void } {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const handleError = () => {
      if (!cancelled) setFailed(true);
    };

    const script =
      document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT}"]`) ??
      (() => {
        const created = document.createElement("script");
        created.src = CHECKOUT_SCRIPT;
        created.async = true;
        document.head.appendChild(created);
        return created;
      })();
    // An existing tag may have errored before this mount — cover it too.
    script.addEventListener("error", handleError);

    const poll = setInterval(() => {
      if (typeof window.Razorpay === "function") {
        if (!cancelled) {
          setReady(true);
          setFailed(false);
          clearInterval(poll);
          clearTimeout(giveUp);
        }
      }
    }, 200);

    // Generous ceiling so a slow connection still gets through; the poll is
    // NOT cleared here, so a late load recovers instead of dead-ending.
    const giveUp = setTimeout(() => {
      if (!cancelled) setFailed(true);
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [attempt]);

  return {
    ready,
    failed,
    retry: () => {
      setFailed(false);
      setReady(false);
      setAttempt((value) => value + 1);
    },
  };
}

type Phase = "idle" | "confirming" | "confirmed" | "dismissed";

export function PaymentCheckout({
  appointmentId,
  amount,
  currency,
}: {
  appointmentId: number;
  amount: string;
  currency: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<CreatePaymentOrderState, FormData>(
    createPaymentOrder,
    null,
  );
  const { ready, failed, retry } = useCheckoutScript();
  const [phase, setPhase] = useState<Phase>("idle");
  const [attempt, setAttempt] = useState(0);
  const openedForOrder = useRef<string | null>(null);

  const order = state?.order ?? null;

  useEffect(() => {
    if (!order || !ready) return;
    // The effect re-runs on every render; each attempt opens the checkout once.
    const key = `${order.orderId}:${attempt}`;
    if (openedForOrder.current === key) return;

    const Razorpay = window.Razorpay;
    if (typeof Razorpay !== "function") return;

    /** Asks the server to verify the payment with the gateway and settle the
     * ledger, with one extra pass in case the gateway reports settlement just
     * after the checkout closes. */
    const confirmAndSettle = async (
      paymentReference: string,
      rechecksLeft: number,
    ): Promise<void> => {
      let result: ConfirmCheckoutResult;
      try {
        result = await confirmCheckout({ razorpayPaymentId: paymentReference });
      } catch {
        result = {
          ok: false,
          error: "Could not reach the server to confirm the payment.",
        };
      }
      if (result.ok) {
        // Forward to the receipt: the payment is settled, so the patient's
        // next step is proof of payment, not a dashboard re-render.
        setPhase("confirmed");
        router.refresh();
        return;
      }
      if (result.notYet && rechecksLeft > 0) {
        setTimeout(() => {
          void confirmAndSettle(paymentReference, rechecksLeft - 1);
        }, 4_000);
        return;
      }
      setPhase("dismissed");
      router.refresh();
    };

    openedForOrder.current = key;
    const checkout = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amountMinor,
      currency: order.currency,
      name: "Medrella",
      description: "Consultation fee",
      theme: { color: "#057f75" },
      handler: (response) => {
        // The success screen is a hint, never the truth: the server verifies
        // the payment with the gateway API (real capture, right amount) and
        // settles the ledger before the dashboard believes anything.
        setPhase("confirming");
        void confirmAndSettle(response.razorpay_payment_id, 1);
      },
      modal: {
        ondismiss: () => {
          // Payment was abandoned: the hold stays until its expiry, and the
          // patient can retry from the same button.
          setPhase("dismissed");
        },
      },
    });

    checkout.on("payment.failed", () => setPhase("dismissed"));
    checkout.open();
  }, [order, ready, router, attempt]);

  // A short beat on the success panel (so the confirmation registers), then
  // straight to the receipt — from the dashboard or the doctor page alike.
  useEffect(() => {
    if (phase !== "confirmed" || !order?.paymentId) return;
    const timer = setTimeout(() => {
      router.push(`/dashboard/patient/receipts/${order.paymentId}`);
    }, 1_400);
    return () => clearTimeout(timer);
  }, [phase, order?.paymentId, router]);

  if (state?.error) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-sm text-rose-800">
        <span aria-hidden="true" className="mt-0.5 text-base leading-none">!</span>
        <div>
          <p className="font-medium">We could not start the payment</p>
          <p className="text-xs text-rose-700">{state.error}</p>
        </div>
      </div>
    );
  }

  if (phase === "confirmed") {
    const receiptHref = order?.paymentId ? `/dashboard/patient/receipts/${order.paymentId}` : null;
    return (
      <div
        role="status"
        className="space-y-1.5 rounded-xl border border-teal-200 bg-teal-50 p-3.5 text-sm text-teal-900"
      >
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-4 w-4 text-teal-700" />
          Payment confirmed
        </p>
        <p className="text-xs text-teal-800">Your appointment is booked. Opening your receipt…</p>
        {receiptHref && (
          <Link
            href={receiptHref}
            className="inline-block text-xs font-semibold text-teal-700 underline-offset-2 hover:underline"
          >
            View receipt now
          </Link>
        )}
      </div>
    );
  }

  if (phase === "confirming") {
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-xl border border-teal-200 bg-teal-50 p-3.5 text-sm text-teal-900">
        <Spinner className="mt-0.5 h-4 w-4 text-teal-700" />
        <div>
          <p className="font-medium">Payment received</p>
          <p className="text-xs text-teal-800">
            Verifying the capture with the payment gateway and confirming your appointment…
          </p>
        </div>
      </div>
    );
  }

  if (order && failed) {
    return (
      <div className="space-y-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5">
        <p className="text-sm font-medium text-amber-900">The payment window could not load</p>
        <p className="text-xs text-amber-800">
          This is usually an ad-blocker or privacy extension blocking the payment provider. Allow this
          site in your blocker, or try a different browser, then retry. Your slot stays held meanwhile.
        </p>
        <Button size="sm" type="button" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }

  if (order) {
    if (phase === "dismissed") {
      return (
        <div className="space-y-2.5 rounded-xl border border-cream-200 bg-white p-3.5">
          <p className="text-sm font-medium text-ink-800">Payment not completed</p>
          <p className="text-xs text-ink-500">
            Your slot is still held for a short while. You can retry now, or pay at the clinic.
          </p>
          <Button
            size="sm"
            type="button"
            onClick={() => {
              // Reopen the same order: the payment row is reused, so no duplicate.
              setPhase("idle");
              setAttempt((value) => value + 1);
            }}
          >
            Try payment again
          </Button>
        </div>
      );
    }
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-ink-600">
        <Spinner className="h-4 w-4 text-teal-700" />
        Opening secure checkout…
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <Button
        type="submit"
        size="sm"
        disabled={pending}
        aria-label={`Pay ${formatCurrency(amount)} ${currency} for this appointment`}
      >
        {pending ? (
          <>
            <Spinner className="h-3.5 w-3.5" /> Preparing…
          </>
        ) : (
          <>
            <CreditCard className="h-3.5 w-3.5" />
            Pay {formatCurrency(amount)}
          </>
        )}
      </Button>
      <p className="text-[11px] text-ink-500">Slot held for 15 minutes while you pay.</p>
    </form>
  );
}
