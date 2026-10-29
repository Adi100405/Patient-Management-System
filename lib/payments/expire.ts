import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, payments } from "@/db/schema";
import { refundLineFor, sendCancellationNotice } from "@/lib/notifications/events";

/**
 * Releases slots held by checkouts that were opened and abandoned.
 *
 * A pending online payment owns its appointment slot until `expiresAt`. Once
 * that passes the payment is marked failed and the appointment cancelled so
 * the slot returns to the pool. Manual (pay-at-clinic) payments carry no
 * expiry and are never touched.
 *
 * Safe to call concurrently: the payment update only matches rows still
 * pending, and the appointment update only matches rows still booked.
 * Returns the number of holds released.
 */
export async function releaseExpiredPayments(): Promise<number> {
  const db = getDb();
  const now = new Date();

  const expired = await db
    .update(payments)
    .set({ status: "failed", failureReason: "checkout_expired", updatedAt: now })
    .where(
      and(
        eq(payments.status, "pending"),
        isNotNull(payments.expiresAt),
        lt(payments.expiresAt, now),
      ),
    )
    .returning({ appointmentId: payments.appointmentId });

  if (expired.length === 0) return 0;

  const cancelled = await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(appointments.status, "booked"),
        inArray(
          appointments.id,
          expired.map((row) => row.appointmentId),
        ),
      ),
    )
    .returning({ id: appointments.id });

  // An abandoned checkout is still a cancelled booking to the patient: tell
  // them why, and say the truth about money — nothing was ever captured.
  for (const appointment of cancelled) {
    await sendCancellationNotice(appointment.id, {
      cancelledBy: "patient",
      reasonLine: "Payment was not completed within the 15-minute hold, so the slot was released.",
      refundLine: refundLineFor({ status: "none", reason: "payment_pending" }),
    });
  }

  return expired.length;
}
