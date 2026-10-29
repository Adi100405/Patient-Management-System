import { NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { payments, refunds } from "@/db/schema";
import { sendRefundUpdate } from "@/lib/notifications/events";
import { getPaymentProvider } from "@/lib/payments";
import { confirmPayment, failPayment } from "@/lib/payments/ledger";
import { syncPaymentRefundState } from "@/lib/refunds/service";

/**
 * Gateway webhook. This endpoint is optional: the checkout confirmation no
 * longer waits for it (see actions/payments.ts, which verifies the payment
 * directly with the gateway). It remains as the backstop for events that can
 * only arrive out-of-band — an asynchronous refund settlement, say — and its
 * signature is verified over the raw body before anything is parsed, so a
 * forged request cannot move money or change state.
 *
 * Every handler is idempotent: providers retry, and events can arrive out of
 * order. A captured payment never downgrades to failed, a repeated capture is a
 * no-op, and a capture that lands after the slot was released restores the
 * booking when the slot is still free — otherwise it is flagged for refund.
 */
export async function POST(request: Request) {
  const provider = getPaymentProvider();
  if (provider.publicKeyId() === null) {
    return NextResponse.json({ error: "Payments are not configured." }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("razorpay-signature") ?? "";

  if (!provider.verifyWebhook(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const event = provider.parseWebhookEvent(rawBody);
  // Events we do not model are acknowledged so the provider stops retrying.
  if (!event) {
    return NextResponse.json({ received: true, ignored: true });
  }

  if (event.type === "refund.settled" || event.type === "refund.failed") {
    const handled = await reconcileRefund(event);
    return NextResponse.json({ received: true, ...handled });
  }

  const db = getDb();
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.providerOrderId, event.orderId))
    .limit(1);

  // An order we never issued (or one from another environment) is not ours to act on.
  if (!payment) {
    return NextResponse.json({ received: true, unmatched: true });
  }

  if (event.type === "captured") {
    await confirmPayment(payment.id, payment.appointmentId, event.paymentId);
    return NextResponse.json({ received: true });
  }

  await failPayment(payment.id, payment.appointmentId, event.paymentId, event.reason);
  return NextResponse.json({ received: true });
}

/**
 * Applies a refund settlement reported by the gateway. Idempotent and
 * order-safe: a completed refund is never reopened by a late failure, and the
 * payment's own status is recomputed from the refund ledger afterwards so a
 * partial refund can never be shown as fully refunded.
 */
async function reconcileRefund(event: {
  type: "refund.settled" | "refund.failed";
  refundId: string;
  providerPaymentId: string;
  noteRefundId?: string;
  reason?: string;
}) {
  const db = getDb();
  let [refund] = await db
    .select({
      id: refunds.id,
      amount: refunds.amount,
      currency: refunds.currency,
      appointmentId: payments.appointmentId,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(eq(refunds.providerRefundId, event.refundId))
    .limit(1);

  // The gateway can settle faster than our own write of its refund id. In that
  // case the id we echoed into the notes is the only link back to our row.
  if (!refund && event.noteRefundId) {
    const localId = Number(event.noteRefundId);
    if (Number.isInteger(localId) && localId > 0) {
      [refund] = await db
        .select({
          id: refunds.id,
          amount: refunds.amount,
          currency: refunds.currency,
          appointmentId: payments.appointmentId,
        })
        .from(refunds)
        .innerJoin(payments, eq(payments.id, refunds.paymentId))
        .where(eq(refunds.id, localId))
        .limit(1);

      if (refund) {
        await db
          .update(refunds)
          .set({ providerRefundId: event.refundId, updatedAt: new Date() })
          .where(eq(refunds.id, refund.id));
      }
    }
  }

  if (!refund) return { unmatched: true };

  if (event.type === "refund.settled") {
    const settled = await db
      .update(refunds)
      .set({ status: "completed", processedAt: new Date(), failureReason: null, updatedAt: new Date() })
      .where(and(eq(refunds.id, refund.id), ne(refunds.status, "completed")))
      .returning({ id: refunds.id });

    if (settled.length > 0) {
      await syncPaymentRefundState(event.providerPaymentId);
      // The row transition is the gate: a replayed settlement never emails.
      await sendRefundUpdate(refund.appointmentId, {
        stage: "completed",
        amount: refund.amount,
        currency: refund.currency,
      });
    }
    return { refundId: refund.id, settled: settled.length > 0 };
  }

  const failed = await db
    .update(refunds)
    .set({
      status: "failed",
      failureReason: event.reason ?? "refund_failed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(refunds.id, refund.id),
        // Only an unsettled refund can fail, so a replayed failure is a no-op
        // and can never repeat the patient's failure email.
        sql`${refunds.status} in ('pending', 'processing')`,
      ),
    )
    .returning({ id: refunds.id });

  if (failed.length > 0) {
    await sendRefundUpdate(refund.appointmentId, {
      stage: "failed",
      amount: refund.amount,
      currency: refund.currency,
    });
  }

  return { refundId: refund.id, failed: failed.length > 0 };
}
