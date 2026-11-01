import { and, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, careFollowUps, visitNotes } from "@/db/schema";
import type { CareFollowUpKind } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { hoursUntilSlot, clinicNow } from "@/lib/slots";
import { sendFollowUpPrompt, sendVisitThanks } from "./events";

/**
 * The post-visit care sweep.
 *
 * Like reminders, care messages are never scheduled as per-appointment jobs.
 * This sweep reads live state — completed visits only — so an appointment that
 * is later reopened simply stops producing care messages, and re-running the
 * sweep costs nothing. The `care_follow_ups` table's unique
 * (appointment_id, kind) index is what makes overlapping sweeps safe: only the
 * insert that claims a row sends that message.
 *
 * Two messages live here:
 *
 *   visit_thanks      — a thank-you shortly after the visit ends.
 *   follow_up_prompt  — the doctor advised a follow-up; prompt when it is due.
 *
 * A follow-up prompt only exists when the doctor set an interval, so the loop
 * stays silent rather than nagging on a guess.
 */

/** A thank-you is still worth sending up to this long after the visit. */
export const THANKS_WINDOW_HOURS = 72;

/** How long past the advised date a follow-up prompt may still be sent. */
export const FOLLOW_UP_GRACE_HOURS = 72;

/** How far back the sweep looks, so a long-lived table is never fully scanned. */
const LOOKBACK_DAYS = 400;

export function thanksDue(hoursSinceVisit: number): boolean {
  return hoursSinceVisit >= 0 && hoursSinceVisit <= THANKS_WINDOW_HOURS;
}

export function followUpDue(hoursSinceVisit: number, followUpDays: number): boolean {
  const dueAt = followUpDays * 24;
  return hoursSinceVisit >= dueAt && hoursSinceVisit <= dueAt + FOLLOW_UP_GRACE_HOURS;
}

export type CareSweepResult = { due: number; sent: number };

function isoDaysBefore(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Claims (appointment, kind) once; concurrent sweeps race and only one wins. */
async function claim(appointmentId: number, kind: CareFollowUpKind): Promise<number | null> {
  const db = getDb();
  try {
    const [claimed] = await db
      .insert(careFollowUps)
      .values({ appointmentId, kind })
      .onConflictDoNothing()
      .returning({ id: careFollowUps.id });
    return claimed?.id ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/**
 * Runs one claimed care message. Returns true when it reached a provider.
 * A failed send releases its claim so a later sweep retries — the same trade
 * reminders make: a possible duplicate after repeated failures is better than
 * silently losing the message.
 */
async function attempt(
  appointmentId: number,
  kind: CareFollowUpKind,
  send: () => Promise<string | null>,
): Promise<boolean> {
  const claimId = await claim(appointmentId, kind);
  if (claimId === null) return false;

  const sentTo = await send();
  const db = getDb();
  if (sentTo) {
    await db.update(careFollowUps).set({ sentTo }).where(eq(careFollowUps.id, claimId));
    return true;
  }
  await db.delete(careFollowUps).where(eq(careFollowUps.id, claimId));
  return false;
}

export async function sweepCareFollowUps(instant: Date = new Date()): Promise<CareSweepResult> {
  const db = getDb();
  const today = clinicNow(instant).date;

  const candidates = await db
    .select({
      id: appointments.id,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      aftercare: visitNotes.aftercare,
      followUpDays: visitNotes.followUpDays,
    })
    .from(appointments)
    .leftJoin(visitNotes, eq(visitNotes.appointmentId, appointments.id))
    .where(
      and(
        eq(appointments.status, "completed"),
        gte(appointments.appointmentDate, isoDaysBefore(today, LOOKBACK_DAYS)),
      ),
    );

  const result: CareSweepResult = { due: 0, sent: 0 };

  for (const appointment of candidates) {
    // Negative until the slot has passed; care only ever follows a visit.
    const hoursSince = -hoursUntilSlot(appointment.date, appointment.time, instant);
    if (hoursSince <= 0) continue;

    if (thanksDue(hoursSince)) {
      result.due += 1;
      const delivered = await attempt(appointment.id, "visit_thanks", () =>
        sendVisitThanks(appointment.id, { hasAftercare: appointment.aftercare !== null }),
      );
      if (delivered) result.sent += 1;
    }

    const days = appointment.followUpDays;
    if (days !== null && followUpDue(hoursSince, days)) {
      result.due += 1;
      const delivered = await attempt(appointment.id, "follow_up_prompt", () =>
        sendFollowUpPrompt(appointment.id, { days }),
      );
      if (delivered) result.sent += 1;
    }
  }

  return result;
}
