import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { payments, refunds } from "@/db/schema";

export type RefundRecord = {
  id: number;
  paymentId: number;
  status: "pending" | "processing" | "completed" | "failed";
  amount: string;
  currency: string;
  reason: string;
  note: string | null;
  failureReason: string | null;
  providerRefundId: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

const refundColumns = {
  id: refunds.id,
  paymentId: refunds.paymentId,
  status: refunds.status,
  amount: refunds.amount,
  currency: refunds.currency,
  reason: refunds.reason,
  note: refunds.note,
  failureReason: refunds.failureReason,
  providerRefundId: refunds.providerRefundId,
  createdAt: refunds.createdAt,
  processedAt: refunds.processedAt,
};

/** Every refund belonging to one patient, newest first, keyed by payment. */
export async function refundsForPatient(patientId: number): Promise<Map<number, RefundRecord[]>> {
  const db = getDb();
  const rows = await db
    .select(refundColumns)
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(eq(payments.patientId, patientId))
    .orderBy(desc(refunds.id));

  const byPayment = new Map<number, RefundRecord[]>();
  for (const row of rows) {
    byPayment.set(row.paymentId, [...(byPayment.get(row.paymentId) ?? []), row]);
  }
  return byPayment;
}

/** The refund history for a single payment, newest first. */
export async function refundsForPayment(paymentId: number): Promise<RefundRecord[]> {
  const db = getDb();
  return db
    .select(refundColumns)
    .from(refunds)
    .where(eq(refunds.paymentId, paymentId))
    .orderBy(desc(refunds.id));
}
