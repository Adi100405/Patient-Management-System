import type { Availability } from "@/db/schema";

/**
 * All availability windows and appointment times in this system are clinic-local
 * wall-clock times. The clinic runs on IST, so "today" and "now" must be resolved
 * in that time zone rather than the server's (UTC on Vercel).
 */
export const CLINIC_TIME_ZONE = "Asia/Kolkata";

/** "09:00" -> minutes since midnight */
function toMinutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function toTime(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Midnight UTC for a "YYYY-MM-DD" string — deterministic on any server time zone. */
function utcDate(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Current clinic date ("YYYY-MM-DD") and minutes since clinic midnight. */
export function clinicNow(instant: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** Clinic clock right now as "HH:MM" — directly comparable with stored times. */
export function clinicClock(instant: Date = new Date()) {
  return toTime(clinicNow(instant).minutes);
}

/** True once the slot has arrived in clinic time, so the visit can be resolved. */
export function slotArrived(date: string, time: string, instant: Date = new Date()) {
  const now = clinicNow(instant);
  return date < now.date || (date === now.date && toMinutes(time) <= now.minutes);
}

export function buildSlots(window: Pick<Availability, "startTime" | "endTime" | "slotMinutes">) {
  const slots: string[] = [];
  const start = toMinutes(window.startTime);
  const end = toMinutes(window.endTime);
  for (let t = start; t + window.slotMinutes <= end; t += window.slotMinutes) {
    slots.push(toTime(t));
  }
  return slots;
}

export type DayOption = {
  date: string;
  dayOfWeek: number;
  label: string;
  isToday: boolean;
};

/** The next `count` clinic days starting today, used for the date picker on a doctor profile. */
export function upcomingDays(count = 7): DayOption[] {
  const today = utcDate(clinicNow().date);
  const days: DayOption[] = [];

  for (let i = 0; i < count; i++) {
    const d = new Date(today.getTime() + i * 86_400_000);
    days.push({
      date: d.toISOString().slice(0, 10),
      dayOfWeek: d.getUTCDay(),
      label: d.toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }),
      isToday: i === 0,
    });
  }

  return days;
}

export function dayOfWeekFor(date: string) {
  return utcDate(date).getUTCDay();
}

/** Removes already-booked and past slots so two patients never see the same free slot. */
export function availableSlots(options: {
  windows: Pick<Availability, "startTime" | "endTime" | "slotMinutes">[];
  date: string;
  bookedTimes: string[];
}) {
  const slots = options.windows.flatMap((w) => buildSlots(w));
  const now = clinicNow();

  return [...new Set(slots)]
    .filter((slot) => !options.bookedTimes.includes(slot))
    .filter((slot) => options.date !== now.date || toMinutes(slot) > now.minutes)
    .sort();
}
