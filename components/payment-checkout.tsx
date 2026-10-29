"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPaymentOrder, type CreatePaymentOrderState } from "@/actions/payments";
import { Button } from "@/components/ui/button";

type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  handler: () => void;
  modal?: { ondismiss?: () => void; escape?: boolean };
  theme?: { color?: string };
};

type RazorpayInstance = { open: () => void; on: (event: string, cb: () => void) => void };

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const CHECKOUT_SCRIPT = "https://checkouts.razorpay.com/v1/checkout.js";

/** Loads the gateway script once and reports when the global constructor is usable. */
function useCheckoutScript(): { ready: boolean; failed: boolean } {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const existing = document.querySelector(`script[src="${CHECKOUT_SCRIPT}"]`);
    if (!existing) {
      const script = document.createElement("script");
      script.src = CHECKOUT_SCRIPT;
      script.async = true;
      script.addEventListener("error", () => {
        if (!cancelled) setFailed(true);
      });
      document.head.appendChild(script);
    }

    const poll = setInterval(() => {
      if (typeof window.Razorpay === "function") {
        if (!cancelled) setReady(true);
        clearInterval(poll);
      }
    }, 200);

    const timeout = setTimeout(() => {
      if (!cancelled) setFailed(true);
      clearInterval(poll);
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearTimeout(timeout);
    };
  }, []);

  return { ready, failed };
}

type Phase = "idle" | "confirming" | "dismissed";

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
  const { ready, failed } = useCheckoutScript();
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

    openedForOrder.current = key;
    const checkout = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amountMinor,
      currency: order.currency,
      name: "Medrella",
      description: "Consultation fee",
      theme: { color: "#0f766e" },
      handler: () => {
        // The webhook is the source of truth for a successful payment. Give it a
        // moment to land, then re-read the server-rendered dashboard.
        setPhase("confirming");
        setTimeout(() => router.refresh(), 2500);
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

  if (state?.error) {
    return <p className="text-sm text-rose-600">{state.error}</p>;
  }

  if (phase === "confirming") {
    return <p className="text-sm text-teal-700">Payment received — confirming your booking…</p>;
  }

  if (order && failed) {
    return (
      <p className="text-sm text-rose-600">
        The payment window could not load. Please refresh and try again.
      </p>
    );
  }

  if (order) {
    if (phase === "dismissed") {
      return (
        <div className="space-y-1">
          <p className="text-sm text-slate-600">
            Payment not completed — this slot is held for a short while.
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
    return <p className="text-sm text-slate-600">Opening secure checkout…</p>;
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Preparing…" : `Pay ${Number(amount)} ${currency}`}
      </Button>
    </form>
  );
}
