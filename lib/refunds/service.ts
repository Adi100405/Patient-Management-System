import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, payments, refunds } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { sendRefundUpdate } from "@/lib/notifications/events";
import { getPaymentProvider } from "@/lib/payments";
import { hoursUntilSlot } from "@/lib/slots";
import { evaluateRefundPolicy } from "./policy";

export type RefundOutcome =
  | { status: "none"; reason: string }
  | { status: "created"; refundId: number; amount: string; note: string }
  | { status: "existing"; refundId: number }
  | { status: "failed"; refundId: number; reason: string };

/**
 * Applies the refund policy to a cancelled appointment and, if money is owed,
 * files a refund with the gateway.
 *
 * Called from the cancellation path, so it must never throw into the UI: a
 * refund that cannot be started is recorded as failed and can be retried, which
 * is strictly better than losing the cancellation itself.
 */
export async function refundForCancellation(input: {
  appointmentId: number;
  cancelledBy: "patient" | "clinic";
  instant?: Date;
}): Promise<RefundOutcome> {
  const db = getDb();

  const [row] = await db
    .select({
      appointmentDate: appointments.appointmentDate,
      appointmentTime: appointments.appointmentTime,
      appointmentStatus: appointments.status,
      paymentId: payments.id,
      paymentStatus: payments.status,
      paymentAmount: payments.amount,
      paymentCurrency: payments.currency,
      providerPaymentId: payments.providerPaymentId,
      provider: payments.provider,
    })
    .from(appointments)
    .innerJoin(payments, eq(payments.appointmentId, appointments.id))
    .where(eq(appointments.id, input.appointmentId))
    .limit(1);

  if (!row) return { status: "none", reason: "no_payment" };

  // Only a cancelled visit can owe a refund; this guards against a caller
  // refunding a live appointment by mistake.
  if (row.appointmentStatus !== "cancelled") {
    return { status: "none", reason: "not_cancelled" };
  }

  // Only captured money can be returned. Pending checkouts are cancelled by the
  // payment flow, and failed ones never took anything.
  if (row.paymentStatus !== "succeeded") {
    return { status: "none", reason: `payment_${row.paymentStatus}` };
  }
  if (!row.providerPaymentId) {
    return { status: "none", reason: "missing_provider_payment" };
  }

  const paidMinor = Math.round(Number(row.paymentAmount) * 100);
  const decision = evaluateRefundPolicy({
    paidMinor,
    hoursUntilStart: hoursUntilSlot(
      row.appointmentDate,
      row.appointmentTime,
      input.instant ?? new Date(),
    ),
    cancelledBy: input.cancelledBy,
  });

  if (!decision.eligible) {
    return { status: "none", reason: decision.reason };
  }

  // One refund per payment per policy reason: a double-click or a retried
  // request cannot produce a second payout.
  const idempotencyKey = `payment-${row.paymentId}:${decision.reason}`;

  let refundId: number;
  try {
    const [created] = await db
      .insert(refunds)
      .values({
        paymentId: row.paymentId,
        amount: (decision.amountMinor / 100).toFixed(2),
        currency: row.paymentCurrency,
        status: "pending",
        reason: decision.reason,
        note: decision.note,
        requestedBy: input.cancelledBy,
        provider: row.provider,
        idempotencyKey,
      })
      .returning({ id: refunds.id });
    refundId = created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [existing] = await db
      .select({ id: refunds.id })
      .from(refunds)
      .where(eq(refunds.idempotencyKey, idempotencyKey))
      .limit(1);
    return existing ? { status: "existing", refundId: existing.id } : { status: "none", reason: "duplicate" };
  }

  const settled = await submitRefund(refundId);
  return settled === "failed"
    ? { status: "failed", refundId, reason: "gateway_rejected" }
    : { status: "created", refundId, amount: (decision.amountMinor / 100).toFixed(2), note: decision.note };
}

/**
 * Files a full refund for money we took but cannot honour: the checkout settled
 * after its slot was released and another patient has since taken the time. The
 * patient is never left holding a payment with no appointment.
 */
export async function refundUnhonouredPayment(paymentId: number): Promise<void> {
  const db = getDb();

  const [payment] = await db
    .select({ id: payments.id, amount: payments.amount, currency: payments.currency, provider: payments.provider })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment) return;

  const idempotencyKey = `payment-${payment.id}:slot_unavailable`;

  try {
    const [created] = await db
      .insert(refunds)
      .values({
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: "pending",
        reason: "slot_unavailable",
        note: "Paid after the slot was released — refunded in full.",
        requestedBy: "system",
        provider: payment.provider,
        idempotencyKey,
      })
      .returning({ id: refunds.id });

    await db
      .update(payments)
      .set({ requiresRefund: true, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));

    await submitRefund(created.id);
  } catch (error) {
    // Already filed (duplicate webhook) — nothing more to do.
    if (!isUniqueViolation(error)) throw error;
  }
}

/**
 * Sends a pending/failed refund to the gateway. Safe to call again: the row
 * moves to `processing` only if it is not already settled.
 */
export async function submitRefund(refundId: number): Promise<"submitted" | "failed"> {
  const db = getDb();

  const [refund] = await db
    .select({
      id: refunds.id,
      amount: refunds.amount,
      currency: refunds.currency,
      status: refunds.status,
      provider: refunds.provider,
      providerRefundId: refunds.providerRefundId,
      appointmentId: payments.appointmentId,
      paymentProviderPaymentId: payments.providerPaymentId,
      paymentProvider: payments.provider,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(eq(refunds.id, refundId))
    .limit(1);

  if (!refund) return "failed";
  if (refund.status === "completed") return "submitted";

  const notifyPatient = (stage: "initiated" | "completed" | "failed") =>
    sendRefundUpdate(refund.appointmentId, {
      stage,
      amount: refund.amount,
      currency: refund.currency,
    });

  if (!refund.paymentProviderPaymentId) {
    await markFailed(refundId, "missing_provider_payment");
    await notifyPatient("failed");
    return "failed";
  }

  const provider = getPaymentProvider();
  if (provider.name !== refund.paymentProvider) {
    await markFailed(refundId, "provider_unavailable");
    await notifyPatient("failed");
    return "failed";
  }

  try {
    const result = await provider.createRefund({
      providerPaymentId: refund.paymentProviderPaymentId,
      amountMinor: Math.round(Number(refund.amount) * 100),
      receipt: `medrella-refund-${refundId}`,
      notes: { refundId: String(refundId) },
    });

    await db
      .update(refunds)
      .set({
        status: result.status === "processed" ? "completed" : "processing",
        providerRefundId: result.id,
        processedAt: result.status === "processed" ? new Date() : null,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(refunds.id, refundId));

    // A gateway that settles synchronously still needs the payment rollup.
    if (result.status === "processed") {
      await syncPaymentRefundState(refund.paymentProviderPaymentId);
    }
    // A synchronously settled refund has nothing left for the webhook to
    // report, so its completion is announced here; an asynchronous one is
    // announced when the gateway's settlement webhook lands.
    await notifyPatient(result.status === "processed" ? "completed" : "initiated");
    return "submitted";
  } catch (error) {
    await markFailed(refundId, error instanceof Error ? error.message : "gateway_rejected");
    await notifyPatient("failed");
    return "failed";
  }
}

async function markFailed(refundId: number, reason: string) {
  await getDb()
    .update(refunds)
    .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
    .where(and(eq(refunds.id, refundId), sql`${refunds.status} <> 'completed'`));
}

/**
 * Recomputes the payment's refund status from the refund ledger, so a partial
 * refund can never be presented as a full one.
 */
export async function syncPaymentRefundState(providerPaymentId: string) {
  const db = getDb();

  const [row] = await db
    .select({
      paymentId: payments.id,
      amount: payments.amount,
      refunded: sql<string>`coalesce(sum(${refunds.amount}) filter (where ${refunds.status} = 'completed'), 0)`,
    })
    .from(payments)
    .leftJoin(refunds, eq(refunds.paymentId, payments.id))
    .where(eq(payments.providerPaymentId, providerPaymentId))
    .groupBy(payments.id, payments.amount)
    .limit(1);

  if (!row) return;

  const paid = Number(row.amount);
  const refunded = Number(row.refunded);
  const status =
    refunded <= 0 ? "succeeded" : refunded + 0.005 >= paid ? "refunded" : "partially_refunded";

  await db
    .update(payments)
    .set({ status, updatedAt: new Date() })
    .where(eq(payments.id, row.paymentId));
}
