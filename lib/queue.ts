import { CLINIC_TIME_ZONE, clinicNow, slotStartsAt } from "./slots";

/**
 * The clinic desk queue.
 *
 * Three facts live on an appointment:
 *
 * - `checkedInAt` — the patient arrived at the desk.
 * - `tokenNumber` — the number on the slip they were given.
 * - `servingStartedAt` — the doctor called them in.
 *
 * Nothing here stores a "queue position". The place in line is derived every
 * time the queue is read, from the order in which people checked in. That is
 * the whole point: a cancellation, a no-show or a finished visit cannot leave
 * a stale number behind, because there is no number to go stale. Tokens are
 * different — a token is a fact about an arrival, so it is never renumbered.
 */

/** How early a patient may check in before their visit time. */
export const CHECK_IN_OPENS_MINUTES = 60;

/** The appointment states this module understands. */
export type QueueStatus = "booked" | "completed" | "cancelled" | "no_show" | "needs_rebooking";

/** Where a patient stands in the queue. */
export type QueueState = "serving" | "waiting" | "not_checked_in" | "done";

export type QueueRow = {
  readonly id: number;
  readonly status: QueueStatus;
  /** "10:30" — the scheduled time, used to order people who are not waiting yet. */
  readonly appointmentTime: string;
  readonly checkedInAt: Date | string | null;
  readonly tokenNumber: number | null;
  readonly servingStartedAt: Date | string | null;
};

export type QueueEntry = {
  readonly id: number;
  readonly state: QueueState;
  /** The booked time this entry belongs to: "10:30". */
  readonly appointmentTime: string;
  /** Place in the live queue, counting from one. Null for anybody not waiting. */
  readonly position: number | null;
  /** The token as it is read out: "T-07". */
  readonly token: string | null;
  readonly checkedInAt: Date | null;
  readonly servingStartedAt: Date | null;
};

export type QueueView = {
  /** The patient in the room, if the doctor has called anybody in. */
  readonly serving: QueueEntry | null;
  /** Checked in and waiting, in check-in order. */
  readonly waiting: readonly QueueEntry[];
  /** Booked for the day but not at the desk yet. */
  readonly notCheckedIn: readonly QueueEntry[];
  /** Finished, missed or cancelled. */
  readonly done: readonly QueueEntry[];
};

/** The token as the desk reads it out. */
export function formatToken(token: number | null): string | null {
  if (token === null) return null;
  return `T-${String(token).padStart(2, "0")}`;
}

function entry(row: QueueRow, state: QueueState, position: number | null = null): QueueEntry {
  return {
    id: row.id,
    state,
    appointmentTime: row.appointmentTime,
    position,
    token: formatToken(row.tokenNumber),
    checkedInAt: row.checkedInAt ? new Date(row.checkedInAt) : null,
    servingStartedAt: row.servingStartedAt ? new Date(row.servingStartedAt) : null,
  };
}

/**
 * Sort the queue for one doctor on one day.
 *
 * People who are waiting are ordered by the moment they checked in, with the
 * appointment id as the tie-break so two people checked in in the same second
 * still get a fixed order. People who have not arrived yet are ordered by
 * their booked time.
 */
export function buildQueue(rows: readonly QueueRow[]): QueueView {
  const serving: QueueEntry[] = [];
  const waiting: QueueEntry[] = [];
  const notCheckedIn: QueueEntry[] = [];
  const done: QueueEntry[] = [];

  for (const row of rows) {
    // A displaced visit is waiting for a new time, not waiting in this queue.
    if (row.status === "needs_rebooking") continue;

    if (row.status !== "booked") {
      done.push(entry(row, "done"));
      continue;
    }
    if (!row.checkedInAt) {
      notCheckedIn.push(entry(row, "not_checked_in"));
      continue;
    }
    if (row.servingStartedAt) {
      serving.push(entry(row, "serving"));
      continue;
    }
    waiting.push(entry(row, "waiting"));
  }

  waiting.sort((a, b) => {
    const aTime = a.checkedInAt?.getTime() ?? 0;
    const bTime = b.checkedInAt?.getTime() ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.id - b.id;
  });

  serving.sort((a, b) => {
    const aTime = a.servingStartedAt?.getTime() ?? 0;
    const bTime = b.servingStartedAt?.getTime() ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.id - b.id;
  });

  notCheckedIn.sort((a, b) => {
    if (a.appointmentTime !== b.appointmentTime) {
      return a.appointmentTime < b.appointmentTime ? -1 : 1;
    }
    return a.id - b.id;
  });

  done.sort((a, b) => {
    if (a.appointmentTime !== b.appointmentTime) {
      return a.appointmentTime < b.appointmentTime ? 1 : -1;
    }
    return b.id - a.id;
  });

  return {
    serving: serving[0] ?? null,
    waiting: waiting.map((item, index) => ({ ...item, position: index + 1 })),
    notCheckedIn,
    done,
  };
}

/** A wall-clock time in clinic time: "10:42 AM". */
export function formatClinicTime(instant: Date | string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export type CheckInWindow =
  | { readonly state: "open" }
  | { readonly state: "before"; readonly opensAt: string }
  | { readonly state: "future" }
  | { readonly state: "closed" };

/**
 * When the desk may check this visit in.
 *
 * Check-in opens an hour before the booked time and stays open for the rest of
 * the visit day. Opening it early would let a patient who turns up at nine in
 * the morning take a low token for a six o'clock visit.
 */
export function checkInWindow(
  date: string,
  time: string,
  instant: Date = new Date(),
): CheckInWindow {
  const now = clinicNow(instant);
  if (date < now.date) return { state: "closed" };
  if (date > now.date) return { state: "future" };

  const opensAt = checkInOpensAt(date, time);
  return instant.getTime() < opensAt.getTime()
    ? { state: "before", opensAt: formatClinicTime(opensAt) }
    : { state: "open" };
}

/** The instant check-in opens for one visit. */
export function checkInOpensAt(date: string, time: string): Date {
  const start = slotStartsAt(date, time);
  const opens = new Date(start.getTime() - CHECK_IN_OPENS_MINUTES * 60_000);
  // A visit booked for the small hours of the morning opens at midnight, not
  // the evening before.
  const midnight = slotStartsAt(date, "00:00");
  return opens.getTime() < midnight.getTime() ? midnight : opens;
}

/** How a position reads for a patient: "You're next" or "Position 3". */
export function positionLabel(position: number | null): string | null {
  if (position === null) return null;
  if (position === 1) return "You're next";
  return `Position ${position}`;
}
