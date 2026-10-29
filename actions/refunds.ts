"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { payments, refunds } from "@/db/schema";
import { submitRefund } from "@/lib/refunds/service";
import { requireSession } from "@/lib/session";

export type RetryRefundState = { error?: string; message?: string } | null;

/**
 * Retries a refund the gateway rejected. Only a patient or doctor tied to the
 * appointment may retry it, and only while the refund is still unsettled — a
 * completed refund is never resubmitted, which is what stops double payouts.
 */
export async function retryRefund(
  _prev: RetryRefundState,
  formData: FormData,
): Promise<RetryRefundState> {
  const session = await requireSession();
  const refundId = Number(formData.get("refundId"));
  if (!Number.isInteger(refundId) || refundId <= 0) {
    return { error: "Invalid refund." };
  }

  const db = getDb();
  const [row] = await db
    .select({
      refundStatus: refunds.status,
      patientId: payments.patientId,
      doctorId: payments.doctorId,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(eq(refunds.id, refundId))
    .limit(1);

  if (!row) return { error: "Refund not found." };

  const ownsIt =
    session.role === "patient"
      ? row.patientId === session.profileId
      : row.doctorId === session.profileId;
  if (!ownsIt) return { error: "That refund does not belong to you." };

  if (row.refundStatus === "completed") {
    return { message: "This refund has already been completed." };
  }
  if (row.refundStatus === "processing") {
    return { message: "This refund is already being processed by the gateway." };
  }

  const result = await submitRefund(refundId);
  revalidatePath("/dashboard/patient");
  revalidatePath("/dashboard/doctor");

  return result === "submitted"
    ? { message: "Refund resubmitted. The gateway will confirm shortly." }
    : { error: "The refund could not be resubmitted. Please try again later." };
}
