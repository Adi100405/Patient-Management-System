"use client";

import { useActionState, useState } from "react";
import { rescheduleAppointment, type RescheduleState } from "@/actions/booking";
import { Button } from "@/components/ui/button";
import { cn, formatDate, formatTime } from "@/lib/utils";

export type RescheduleDayOption = {
  date: string;
  label: string;
  isToday: boolean;
  /** Free slots for this doctor on this day, at the moment the page rendered. */
  times: string[];
};

/**
 * Inline "move my appointment" picker for the patient dashboard. Days and free
 * slots are computed server-side (same availability logic as booking) and
 * passed in; the final say still belongs to the server action — if someone
 * takes the slot between render and submit, the patient is told honestly.
 */
export function RescheduleAppointment({
  appointmentId,
  currentLabel,
  days,
}: {
  appointmentId: number;
  currentLabel: string;
  days: RescheduleDayOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<RescheduleState, FormData>(
    rescheduleAppointment,
    null,
  );
  const [dayIndex, setDayIndex] = useState(() => days.findIndex((d) => d.times.length > 0));
  const [selected, setSelected] = useState<string | null>(null);

  const day = dayIndex >= 0 ? days[dayIndex] : undefined;

  if (!open) {
    return (
      <Button variant="outline" size="sm" type="button" onClick={() => setOpen(true)}>
        Reschedule
      </Button>
    );
  }

  if (state?.message) {
    return (
      <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">
        Moved. {state.message}
      </div>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-3 rounded-lg border border-slate-200 p-3">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      {day && <input type="hidden" name="date" value={day.date} />}
      {selected && <input type="hidden" name="time" value={selected} />}

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-700">
          Move from {currentLabel}
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          Never mind
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {days.map((option, index) => (
          <button
            key={option.date}
            type="button"
            onClick={() => {
              setDayIndex(index);
              setSelected(null);
            }}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-xs font-medium transition",
              index === dayIndex
                ? "border-teal-600 bg-teal-600 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
            )}
          >
            {option.isToday ? "Today" : option.label}
            {option.times.length === 0 && <span className="ml-1 opacity-70">(full)</span>}
          </button>
        ))}
      </div>

      {day && day.times.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {day.times.map((time) => (
            <button
              key={time}
              type="button"
              onClick={() => setSelected(time)}
              className={cn(
                "rounded-lg border px-2 py-1.5 text-xs font-medium transition",
                selected === time
                  ? "border-teal-600 bg-teal-600 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-teal-400 hover:bg-teal-50",
              )}
            >
              {formatTime(time)}
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          No free slots on this day. Try another day.
        </p>
      )}

      {state?.error && (
        <p className="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{state.error}</p>
      )}

      <Button type="submit" size="sm" className="w-full" disabled={pending || !selected}>
        {pending
          ? "Moving…"
          : selected
            ? `Move to ${formatDate(day!.date)} ${formatTime(selected)}`
            : "Pick a new slot"}
      </Button>
    </form>
  );
}
