import type { Availability } from "@/db/schema";
import { toDateInputValue } from "./utils";

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

/** The next `count` days starting today, used for the date picker on a doctor profile. */
export function upcomingDays(count = 7): DayOption[] {
  const today = new Date();
  const days: DayOption[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push({
      date: toDateInputValue(d),
      dayOfWeek: d.getDay(),
      label: d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }),
      isToday: i === 0,
    });
  }
  return days;
}

export function dayOfWeekFor(date: string) {
  return new Date(`${date}T00:00:00`).getDay();
}

/** Removes already-booked and past slots so two patients never see the same free slot. */
export function availableSlots(options: {
  windows: Pick<Availability, "startTime" | "endTime" | "slotMinutes">[];
  date: string;
  bookedTimes: string[];
}) {
  const slots = options.windows.flatMap((w) => buildSlots(w));
  const now = new Date();
  const todayValue = toDateInputValue(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return [...new Set(slots)]
    .filter((slot) => !options.bookedTimes.includes(slot))
    .filter((slot) => options.date !== todayValue || toMinutes(slot) > nowMinutes)
    .sort();
}
