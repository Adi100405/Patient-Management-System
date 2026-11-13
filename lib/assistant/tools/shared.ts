import { visitWhenLabel, type SchedulingType } from "@/lib/schedule";
import { clinicNow } from "@/lib/slots";
import { formatDate } from "@/lib/utils";
import type { AssistantContext, ToolOutcome } from "@/lib/assistant/types";

/**
 * Small helpers every tool shares. Tools are thin wrappers over the code the
 * dashboards already use; anything a tool needs to format is formatted here
 * once, so a doctor phrase and a patient phrase can never drift apart.
 */

export type ToolHandler = (args: unknown, ctx: AssistantContext) => Promise<ToolOutcome>;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Clinic "today" as YYYY-MM-DD — one source of truth for every tool. */
export function today(): string {
  return clinicNow().date;
}

/**
 * Keep the last four digits, hide the rest. The assistant may confirm which
 * number on file is being used; it must never read a full number aloud.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const compact = phone.replace(/\s+/g, "");
  if (compact.length <= 4) return "*".repeat(compact.length);
  return `${"*".repeat(compact.length - 4)}${compact.slice(-4)}`;
}

/**
 * "Tue, Nov 11 at 10:30 AM" — or the window range for a stream visit. Reuses
 * the visit label the dashboards render, so the assistant and the screen agree.
 */
export function whenLabel(row: {
  readonly date: string;
  readonly time: string;
  readonly schedulingType: SchedulingType | null;
  readonly windowEnd: string | null;
}): string {
  return `${formatDate(row.date)}, ${visitWhenLabel({
    schedulingType: row.schedulingType ?? "wave",
    time: row.time,
    windowEnd: row.windowEnd,
  })}`;
}

/**
 * The patterns a name search should try: the whole typed phrase first, then
 * its words.
 *
 * A name typed in another script ("डॉ. आरव मेहता") cannot match the Latin name
 * the platform stores, but a word match still finds the right doctor once the
 * words overlap, and the list fallback covers the rest.
 */
export function nameMatchPatterns(term: string): string[] {
  const trimmed = term.trim();
  if (!trimmed) return [];
  const words = trimmed
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((word) => word.length >= 3 && word !== trimmed);
  return [trimmed, ...words];
}

export function toClinicTime(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** A tool failure the model can explain; never a thrown 500. */
export function errorResult(message: string): ToolOutcome {
  return { result: { error: message } };
}
