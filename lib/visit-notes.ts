/**
 * The two pieces of post-visit care a doctor records when resolving a visit:
 * free-text aftercare and an optional follow-up interval.
 *
 * Parsing is kept pure — no database, no clock — so the bounds below are the
 * single, testable place that decides what a note may contain. Anything the
 * form sends that is not a sensible value becomes `null` rather than an error:
 * a doctor completing a visit must never be blocked by an optional field.
 */

/** Longest aftercare note stored, so an accidental paste cannot balloon a row. */
export const MAX_AFTERCARE_LENGTH = 4000;

/** Furthest follow-up we accept (a year); beyond that it is not a follow-up. */
export const MAX_FOLLOW_UP_DAYS = 365;

export function normalizeAftercare(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_AFTERCARE_LENGTH);
}

export function normalizeFollowUpDays(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || !/^\d+$/.test(value)) return null;
  const days = Number(value);
  if (days < 1 || days > MAX_FOLLOW_UP_DAYS) return null;
  return days;
}
