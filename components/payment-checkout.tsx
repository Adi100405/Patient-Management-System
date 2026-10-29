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
      <div className="space-y-1">
        <p className="text-sm text-rose-600">The payment window could not load.</p>
        <p className="text-xs text-slate-600">
          This is usually an ad-blocker or privacy extension blocking the payment provider. Allow
          this site in your blocker, or try a different browser, then:
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
