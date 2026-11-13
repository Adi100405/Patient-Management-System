import { z } from "zod";
import { formatDate, formatTime } from "@/lib/utils";
import type { AssistantRole, ReplyLanguage } from "./types";

/**
 * The assistant's degraded mode.
 *
 * When the model is unavailable - a rate limit, a timeout, a missing key - the
 * chat route can still answer the questions the dashboards answer at a glance,
 * straight from the database. This module owns that path: it decides which
 * read a message needs, which tool answers it, and how the answer reads.
 *
 * It is deliberately narrow. A fallback never writes, never guesses, and never
 * invents a doctor or a slot: if the tool result does not match the shape the
 * formatter knows, the formatter returns null and the route reports that the
 * assistant is unavailable.
 */

/** What a read-only answer can be built from when the model is unavailable. */
export type FallbackIntent =
  | { readonly kind: "appointments"; readonly scope: "upcoming" | "past" }
  | { readonly kind: "payments" }
  | { readonly kind: "prescriptions" }
  | { readonly kind: "doctors"; readonly query: string | null }
  | { readonly kind: "today" }
  | { readonly kind: "stats" }
  | { readonly kind: "availability" }
  | { readonly kind: "conflicts" }
  | { readonly kind: "next_slot" };

/** The tool that answers an intent, and the arguments it needs. */
export type FallbackPlan = {
  readonly intent: FallbackIntent;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
};

const SPECIALITY =
  /(dermatolog\w*|cardiolog\w*|gynecolog\w*|pediatric\w*|orthoped\w*|neurolog\w*|psychiatr\w*|dentist\w*|physician)/i;

/**
 * Maps a message to the one read the fallback can answer without a model. It
 * is deliberately narrow: a fallback is for "the model is busy", not a second
 * assistant, so it only covers the questions the dashboards answer at a glance.
 */
export function classifyFallbackIntent(
  role: AssistantRole,
  message: string,
): FallbackIntent | null {
  const text = message.toLowerCase();

  if (role === "patient") {
    if (/\b(payment|payments|refund|refunds|paid|receipt|invoice)\b/.test(text)) {
      return { kind: "payments" };
    }
    if (/\b(prescription|prescriptions|aftercare|medicine|medication)\b/.test(text)) {
      return { kind: "prescriptions" };
    }
    if (/\b(past|previous|history|older|cancelled|canceled)\b/.test(text)) {
      return { kind: "appointments", scope: "past" };
    }
    if (/\b(appointment|appointments|visit|visits|booking|bookings)\b/.test(text)) {
      return { kind: "appointments", scope: "upcoming" };
    }
    const speciality = SPECIALITY.exec(text);
    if (speciality) {
      return { kind: "doctors", query: speciality[0] };
    }
    if (/\b(doctor|doctors|specialist)\b/.test(text)) {
      return { kind: "doctors", query: null };
    }
    return null;
  }

  if (/\b(conflict|conflicts|overlap|overlapping|double.?book|clash)\b/.test(text)) {
    return { kind: "conflicts" };
  }
  if (/\b(next (?:free|available)|earliest|soonest|first free)\b/.test(text)) {
    return { kind: "next_slot" };
  }
  if (
    /\b(stat|stats|statistic|statistics|count|counts|how many|seen|no.?show|completed|cancelled|canceled|confirmed)\b/.test(
      text,
    )
  ) {
    return { kind: "stats" };
  }
  if (/\b(today|who is coming|coming in|my day|today'?s schedule)\b/.test(text)) {
    return { kind: "today" };
  }
  if (/\b(availability|available|hours|working|window|windows|shift|shifts|leave|closed)\b/.test(text)) {
    return { kind: "availability" };
  }
  if (/\b(schedule|appointments|appointment|visits)\b/.test(text)) {
    return { kind: "today" };
  }
  return null;
}

/**
 * The read that answers an intent. The tool names belong to the role that
 * produced the intent, and the route runs them through the same role-gated
 * dispatch the model uses, so a fallback can never widen its own scope.
 */
export function planFor(intent: FallbackIntent): FallbackPlan {
  switch (intent.kind) {
    case "appointments":
      return { intent, tool: "my_appointments", args: { scope: intent.scope } };
    case "payments":
      return { intent, tool: "my_payments_and_refunds", args: {} };
    case "prescriptions":
      return { intent, tool: "my_prescriptions", args: {} };
    case "doctors":
      return { intent, tool: "search_doctors", args: { query: intent.query ?? "" } };
    case "today":
      return { intent, tool: "appointments_for_date", args: {} };
    case "stats":
      return { intent, tool: "appointment_stats", args: {} };
    case "availability":
      return { intent, tool: "availability_overview", args: {} };
    case "conflicts":
      return { intent, tool: "detect_conflicts", args: {} };
    case "next_slot":
      return { intent, tool: "next_available_slot", args: {} };
    default:
      return assertNever(intent);
  }
}

/**
 * The tool results this formatter can read. A result that does not match is
 * refused rather than half-read: the route then reports that the assistant is
 * unavailable, which is true, instead of sending a made-up answer.
 */
const patientAppointments = z.object({
  count: z.number(),
  appointments: z.array(
    z.object({
      doctorName: z.string(),
      when: z.string(),
      status: z.string(),
    }),
  ),
});

const payments = z.object({
  payments: z.array(
    z.object({
      doctorName: z.string(),
      dateLabel: z.string(),
      amount: z.coerce.number(),
      currency: z.string(),
      status: z.string(),
      refund: z
        .object({ amount: z.coerce.number(), status: z.string(), note: z.string().nullable() })
        .nullable(),
    }),
  ),
});

const prescriptions = z.object({
  prescriptions: z.array(
    z.object({
      doctorName: z.string(),
      dateLabel: z.string(),
      aftercare: z.string().nullable(),
      followUpDays: z.number().nullable(),
    }),
  ),
});

const doctors = z.object({
  doctors: z.array(
    z.object({
      name: z.string(),
      specialization: z.string(),
      experienceYears: z.number(),
      fee: z.coerce.number(),
    }),
  ),
});

const doctorDay = z.object({
  date: z.string(),
  appointments: z.array(
    z.object({
      patientName: z.string(),
      when: z.string(),
      time: z.string(),
      status: z.string(),
    }),
  ),
});

const doctorStats = z.object({
  date: z.string(),
  today: z.number(),
  upcoming: z.number(),
  patientsSeen: z.number(),
  noShows: z.number(),
  completed: z.number(),
  cancelled: z.number(),
});

const scheduleWindows = z.object({
  windows: z.array(
    z.object({
      type: z.string(),
      dayOfWeek: z.number().nullable(),
      dates: z.array(z.string()),
      startTime: z.string(),
      endTime: z.string(),
      capacity: z.number(),
      closed: z.boolean(),
    }),
  ),
});

const conflicts = z.object({
  conflicts: z.array(z.object({ window: z.string(), overlapsWith: z.string() })),
});

const freeSlots = z.object({
  slots: z.array(z.object({ date: z.string(), time: z.string(), free: z.number() })),
});

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * What the user sees before the quick answer. The answer itself stays in the
 * clinic's own words (names, dates, statuses); the notice is what tells the
 * person that the assistant could not do the rest.
 */
const BUSY_NOTICE: Record<ReplyLanguage, string> = {
  en: "The assistant is busy right now, so here is the quick answer from your dashboard:",
  hi: "असिस्टेंट अभी व्यस्त है, इसलिए यह आपके डैशबोर्ड से तुरंत जानकारी है:",
  hinglish: "Assistant abhi busy hai, isliye yeh aapke dashboard se quick answer hai:",
};

/**
 * Renders the quick answer. Returns null when the tool result is not the
 * shape this formatter knows, so the caller can fall back to "unavailable".
 */
export function formatFallbackReply(
  plan: FallbackPlan,
  result: unknown,
  language: ReplyLanguage,
): string | null {
  const answer = answerFor(plan.intent, result);
  if (!answer) return null;
  return `${BUSY_NOTICE[language]} ${answer}`;
}

function answerFor(intent: FallbackIntent, result: unknown): string | null {
  switch (intent.kind) {
    case "appointments":
      return appointmentsAnswer(intent.scope, result);
    case "payments":
      return paymentsAnswer(result);
    case "prescriptions":
      return prescriptionsAnswer(result);
    case "doctors":
      return doctorsAnswer(intent.query, result);
    case "today":
      return todayAnswer(result);
    case "stats":
      return statsAnswer(result);
    case "availability":
      return availabilityAnswer(result);
    case "conflicts":
      return conflictsAnswer(result);
    case "next_slot":
      return nextSlotAnswer(result);
    default:
      return assertNever(intent);
  }
}

function appointmentsAnswer(scope: "upcoming" | "past", result: unknown): string | null {
  const parsed = patientAppointments.safeParse(result);
  if (!parsed.success) return null;
  const { count, appointments } = parsed.data;
  if (count === 0) {
    return scope === "upcoming"
      ? "You have no upcoming appointments."
      : "You have no past appointments.";
  }
  const list = appointments.map((row) => `${row.doctorName} (${row.when})`).join("; ");
  const label = scope === "upcoming" ? "upcoming appointment" : "past appointment";
  return `${count} ${label}${count === 1 ? "" : "s"}: ${list}.`;
}

function paymentsAnswer(result: unknown): string | null {
  const parsed = payments.safeParse(result);
  if (!parsed.success) return null;
  if (parsed.data.payments.length === 0) return "No payments are on file yet.";
  const list = parsed.data.payments
    .map((row) => {
      const refund = row.refund ? `, refund ${Math.round(row.refund.amount)} ${row.refund.status}` : "";
      return `${row.doctorName}, ${Math.round(row.amount)} ${row.currency} (${row.status}${refund})`;
    })
    .join("; ");
  return `${parsed.data.payments.length} payments: ${list}.`;
}

function prescriptionsAnswer(result: unknown): string | null {
  const parsed = prescriptions.safeParse(result);
  if (!parsed.success) return null;
  if (parsed.data.prescriptions.length === 0) return "No prescriptions are on file yet.";
  const list = parsed.data.prescriptions
    .map((row) => `${row.doctorName} (${row.dateLabel})`)
    .join("; ");
  return `${parsed.data.prescriptions.length} prescriptions: ${list}.`;
}

function doctorsAnswer(query: string | null, result: unknown): string | null {
  const parsed = doctors.safeParse(result);
  if (!parsed.success) return null;
  if (parsed.data.doctors.length === 0) {
    return query ? `I found no doctor matching ${query}.` : "I found no doctors.";
  }
  const list = parsed.data.doctors
    .map((row) => `${row.name}, ${row.specialization} (${Math.round(row.fee)} INR)`)
    .join("; ");
  return `${parsed.data.doctors.length} doctors found: ${list}.`;
}

function todayAnswer(result: unknown): string | null {
  const parsed = doctorDay.safeParse(result);
  if (!parsed.success) return null;
  if (parsed.data.appointments.length === 0) return "You have no visits scheduled today.";
  const list = parsed.data.appointments
    .map((row) => `${formatTime(row.time)} ${row.patientName} (${row.status})`)
    .join("; ");
  const count = parsed.data.appointments.length;
  return `${count} visit${count === 1 ? "" : "s"} today: ${list}.`;
}

function statsAnswer(result: unknown): string | null {
  const parsed = doctorStats.safeParse(result);
  if (!parsed.success) return null;
  const stats = parsed.data;
  return `${stats.today} booked today, ${stats.upcoming} upcoming, ${stats.patientsSeen} patients seen, ${stats.noShows} no-shows, ${stats.completed} completed, ${stats.cancelled} cancelled.`;
}

function availabilityAnswer(result: unknown): string | null {
  const parsed = scheduleWindows.safeParse(result);
  if (!parsed.success) return null;
  if (parsed.data.windows.length === 0) return "You have no published schedule windows.";
  const list = parsed.data.windows
    .map((window) => {
      const day =
        window.dayOfWeek === null
          ? window.dates.map((date) => formatDate(date)).join(", ")
          : (DAY_NAMES[window.dayOfWeek] ?? "Weekly");
      const closed = window.closed ? " (closed)" : "";
      return `${day} ${formatTime(window.startTime)} – ${formatTime(window.endTime)}${closed}`;
    })
    .join("; ");
  return `${parsed.data.windows.length} schedule windows: ${list}.`;
}

function conflictsAnswer(result: unknown): string | null {
  const parsed = conflicts.safeParse(result);
  if (!parsed.success) return null;
  if (parsed.data.conflicts.length === 0) return "No schedule conflicts found.";
  const list = parsed.data.conflicts
    .map((row) => `${row.window} overlaps ${row.overlapsWith}`)
    .join("; ");
  return `${parsed.data.conflicts.length} conflicts: ${list}.`;
}

function nextSlotAnswer(result: unknown): string | null {
  const parsed = freeSlots.safeParse(result);
  if (!parsed.success) return null;
  const first = parsed.data.slots[0];
  if (!first) return "No free slot in the next eight days.";
  return `Next free slot: ${formatDate(first.date)} at ${formatTime(first.time)}.`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled fallback intent: ${JSON.stringify(value)}`);
}
