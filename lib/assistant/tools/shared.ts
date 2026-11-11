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

/** A tool failure the model can explain; never a thrown 500. */
export function errorResult(message: string): ToolOutcome {
  return { result: { error: message } };
}
