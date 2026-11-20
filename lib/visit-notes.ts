/**
 * The four pieces of a completed visit a doctor can record:
 *
 * - `diagnosis` — the short clinical conclusion,
 * - `summary` — what was found and done during the consultation,
 * - `aftercare` — the instructions the patient takes home,
 * - `followUpDays` — the recommended interval before the next visit.
 *
 * Parsing is kept pure — no database, no clock — so the bounds below are the
 * single, testable place that decides what a note may contain. Anything the
 * form sends that is not a sensible value becomes `null` rather than an error:
 * a doctor completing a visit must never be blocked by an optional field.
 */

/** Longest diagnosis stored: a short label, not a second summary. */
export const MAX_DIAGNOSIS_LENGTH = 300;

/** Longest consultation summary stored, so an accidental paste stays bounded. */
export const MAX_SUMMARY_LENGTH = 4000;

/** Longest aftercare note stored, so an accidental paste cannot balloon a row. */
export const MAX_AFTERCARE_LENGTH = 4000;

/** Furthest follow-up we accept (a year); beyond that it is not a follow-up. */
export const MAX_FOLLOW_UP_DAYS = 365;

function normalizeText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

export function normalizeDiagnosis(raw: unknown): string | null {
  return normalizeText(raw, MAX_DIAGNOSIS_LENGTH);
}

export function normalizeVisitSummary(raw: unknown): string | null {
  return normalizeText(raw, MAX_SUMMARY_LENGTH);
}

export function normalizeAftercare(raw: unknown): string | null {
  return normalizeText(raw, MAX_AFTERCARE_LENGTH);
}

export function normalizeFollowUpDays(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || !/^\d+$/.test(value)) return null;
  const days = Number(value);
  if (days < 1 || days > MAX_FOLLOW_UP_DAYS) return null;
  return days;
}
