import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, payments, reminders } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { sendAppointmentReminder } from "./events";
import { clinicNow, hoursUntilSlot } from "@/lib/slots";

/**
 * When each reminder is still worth sending, in hours before the visit starts.
 * The window closes early rather than going out stale: under two hours before
 * the visit the 1h reminder says it better than a belated "tomorrow" email,
 * and nothing fires once the visit has started.
 */
const REMINDER_WINDOWS: Record<"24h" | "1h", { from: number; to: number }> = {
  "24h": { from: 2, to: 25 },
  "1h": { from: 0.05, to: 1.25 },
};

export type ReminderSweepResult = { due: number; sent: number };

/**
 * Sends every appointment reminder that is due and not yet on the ledger.
 *
 * Reminders are never scheduled per appointment. This sweep reads live state —
 * booked visits only — so cancelling (or completing) an appointment removes its
 * reminders with no cleanup step, and a rescheduled visit could never be
 * announced at its old time. The unique (appointment_id, kind) index makes
 * overlapping sweeps safe: only the insert that claims a row sends that email.
 *
 * A failed send releases its claim so a later sweep retries. The cost of that
 * trade is a possible duplicate after repeated failures — much better than
 * silently losing a reminder.
 */
export async function sweepReminders(instant: Date = new Date()): Promise<ReminderSweepResult> {
  const db = getDb();
  const today = clinicNow(instant).date;

  const candidates = await db
    .select({
      id: appointments.id,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      /** An expired pending payment means the hold is about to lapse — skip. */
      paymentStatus: payments.status,
      paymentExpiresAt: payments.expiresAt,
    })
    .from(appointments)
    .leftJoin(payments, eq(payments.appointmentId, appointments.id))
    .where(
      and(
        eq(appointments.status, "booked"),
        // Text column holding "YYYY-MM-DD", so this string comparison is a date
        // comparison. Today is included: a 1h reminder may still be due.
        gte(appointments.appointmentDate, today),
      ),
    );

  const result: ReminderSweepResult = { due: 0, sent: 0 };

  for (const appointment of candidates) {
    if (
      appointment.paymentStatus === "pending" &&
      appointment.paymentExpiresAt !== null &&
      appointment.paymentExpiresAt.getTime() <= instant.getTime()
    ) {
      continue;
    }

    const hoursUntil = hoursUntilSlot(appointment.date, appointment.time, instant);
    if (hoursUntil <= 0) continue;

    for (const kind of ["24h", "1h"] as const) {
      const window = REMINDER_WINDOWS[kind];
      if (hoursUntil < window.from || hoursUntil > window.to) continue;
      result.due += 1;

      // Claim first: concurrent sweeps race here and only one wins.
      let claimId: number | null = null;
      try {
        const [claimed] = await db
          .insert(reminders)
          .values({ appointmentId: appointment.id, kind })
          .onConflictDoNothing()
          .returning({ id: reminders.id });
        claimId = claimed?.id ?? null;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      if (claimId === null) continue; // already sent, or being sent right now

      const sentTo = await sendAppointmentReminder(appointment.id, kind);
      if (sentTo) {
        await db
          .update(reminders)
          .set({ sentTo })
          .where(and(eq(reminders.id, claimId), sql`${reminders.sentTo} is null`));
        result.sent += 1;
      } else {
        // Delivery failed — release the claim so the next sweep retries.
        await db.delete(reminders).where(eq(reminders.id, claimId));
      }
    }
  }

  return result;
}
