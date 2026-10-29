import { NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, payments, refunds } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { sendPaymentConfirmation, sendRefundUpdate } from "@/lib/notifications/events";
import { getPaymentProvider } from "@/lib/payments";
import { refundUnhonouredPayment, syncPaymentRefundState } from "@/lib/refunds/service";

/**
 * Gateway webhook. The signature is verified over the raw body before anything
 * is parsed, so a forged request cannot move money or change state.
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

async function confirmPayment(paymentId: number, appointmentId: number, providerPaymentId: string) {
  const db = getDb();
  const now = new Date();

  // Conditional on "not already succeeded": duplicate captures update nothing.
  const confirmed = await db
    .update(payments)
    .set({
      status: "succeeded",
      providerPaymentId,
      paidAt: now,
      updatedAt: now,
      expiresAt: null,
      failureReason: null,
    })
    .where(and(eq(payments.id, paymentId), ne(payments.status, "succeeded")))
    .returning({ id: payments.id });

  if (confirmed.length === 0) return;

  await restoreAppointment(appointmentId, paymentId);
  // Only a real transition reaches here, so a duplicate capture never emails.
  await sendPaymentConfirmation(appointmentId);
}

/**
 * A successful payment must leave the patient with a visit. If the hold was
 * released before the money settled (slow checkout, expired slot), the
 * appointment is reinstated — unless another patient has since taken the slot,
 * in which case the payment is refunded in full rather than double-booking the
 * doctor or keeping money for a visit that will not happen.
 */
async function restoreAppointment(appointmentId: number, paymentId: number) {
  const db = getDb();
  try {
    await db
      .update(appointments)
      .set({ status: "booked" })
      .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "cancelled")));
  } catch (error) {
    if (!isUniqueViolation(error, "appointments_booked_slot_unique")) throw error;
    await refundUnhonouredPayment(paymentId);
  }
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

async function failPayment(
  paymentId: number,
  appointmentId: number,
  providerPaymentId: string,
  reason: string,
) {
  const db = getDb();
  const now = new Date();

  const failed = await db
    .update(payments)
    .set({
      status: "failed",
      providerPaymentId,
      failureReason: reason,
      updatedAt: now,
      expiresAt: null,
    })
    .where(and(eq(payments.id, paymentId), eq(payments.status, "pending")))
    .returning({ id: payments.id });

  // A failure for an already-settled payment is stale news, not a state change.
  if (failed.length === 0) return;

  await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "booked")));
}
