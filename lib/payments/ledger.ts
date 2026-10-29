import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, payments } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { sendPaymentConfirmation } from "@/lib/notifications/events";
import { refundUnhonouredPayment } from "@/lib/refunds/service";

/**
 * The payment ledger's confirm / fail transitions, shared by every entry
 * point: the direct gateway-check confirmation action (see
 * actions/payments.ts) and the optional webhook route. All of them are
 * idempotent: providers and patients retry, events may arrive twice or out of
 * order, so a settled payment can never move backwards or double-email.
 */

/**
 * Settles a captured payment in our ledger.
 *
 * Conditional on "not already succeeded": duplicate captures update nothing.
 */
export async function confirmPayment(
  paymentId: number,
  appointmentId: number,
  providerPaymentId: string,
) {
  const db = getDb();
  const now = new Date();

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
 * Marks a payment failed. A failure for an already-settled payment is stale
 * news, not a state change.
 */
export async function failPayment(
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

  if (failed.length === 0) return;

  await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "booked")));
}
