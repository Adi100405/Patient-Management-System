"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { appointments, payments } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPaymentProvider, PAYMENT_HOLD_MINUTES } from "@/lib/payments";
import { releaseExpiredPayments } from "@/lib/payments/expire";

export type CreatePaymentOrderState = {
  error?: string;
  order?: {
    orderId: string;
    amountMinor: number;
    currency: string;
    keyId: string;
    paymentId: number;
  };
} | null;

/**
 * Opens a checkout for a booked appointment.
 *
 * The amount is read from the payment row (which was itself copied from the
 * doctor's consultation fee at booking time) — never from the client. Reusing
 * the existing pending payment keeps retries from creating duplicate ledger
 * rows, and each attempt refreshes the slot hold.
 */
export async function createPaymentOrder(
  _prev: CreatePaymentOrderState,
  formData: FormData,
): Promise<CreatePaymentOrderState> {
  const session = await requireSession();
  if (session.role !== "patient") {
    return { error: "Only patients can pay for appointments." };
  }

  const appointmentId = Number(formData.get("appointmentId"));
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    return { error: "Invalid appointment." };
  }

  const provider = getPaymentProvider();
  const keyId = provider.publicKeyId();
  if (!keyId) {
    return { error: "Online payments are not available. Please pay at the clinic." };
  }

  const db = getDb();
  // Release any abandoned holds first, so a checkout cannot be opened for an
  // appointment whose slot has already been reclaimed.
  await releaseExpiredPayments();

  const [appointment] = await db
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      status: appointments.status,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!appointment) return { error: "Appointment not found." };
  if (appointment.patientId !== session.profileId) {
    return { error: "That appointment does not belong to you." };
  }
  if (appointment.status !== "booked") {
    return { error: "This appointment is not awaiting payment." };
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.appointmentId, appointmentId))
    .limit(1);

  if (!payment) return { error: "No payment record exists for this appointment." };
  if (payment.status === "succeeded") return { error: "This appointment is already paid." };
  if (payment.status === "failed") {
    return { error: "This payment failed. Please pay at the clinic or contact support." };
  }

  // Re-check expiry immediately before charging so an abandoned hold from
  // another tab cannot be resurrected after its slot was released.
  try {
    const order = await provider.createOrder({
      amountMinor: Math.round(Number(payment.amount) * 100),
      currency: payment.currency,
      receipt: `medrella-appt-${appointmentId}`,
      notes: { appointmentId: String(appointmentId), patientId: String(appointment.patientId) },
    });

    const expiresAt = new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000);
    await db
      .update(payments)
      .set({
        provider: provider.name,
        providerOrderId: order.id,
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    revalidatePath("/dashboard/patient");

    return {
      order: {
        orderId: order.id,
        amountMinor: order.amountMinor,
        currency: order.currency,
        keyId,
        paymentId: payment.id,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not start the payment. Please try again.";
    return { error: message };
  }
}
