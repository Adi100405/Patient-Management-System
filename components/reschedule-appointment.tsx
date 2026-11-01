"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
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
 *
 * When closed this is a single quiet action; when open the panel spans the row
 * so the day strip and slot grid have room to breathe on a phone.
 */
export function RescheduleAppointment({
  appointmentId,
  currentLabel,
  currentDate,
  currentTime,
  days,
}: {
  appointmentId: number;
  currentLabel: string;
  currentDate: string;
  currentTime: string;
  days: RescheduleDayOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<RescheduleState, FormData>(
    rescheduleAppointment,
    null,
  );
  /** Slots this patient can actually move to (their own slot is not one). */
  const selectableTimes = (option: RescheduleDayOption) =>
    option.times.filter((time) => !(option.date === currentDate && time === currentTime));

  const [dayIndex, setDayIndex] = useState(() =>
    days.findIndex((d) => selectableTimes(d).length > 0),
  );
  const [selected, setSelected] = useState<string | null>(null);

  const day = dayIndex >= 0 ? days[dayIndex] : undefined;
  const isCurrentSlot = (date: string, time: string) =>
    date === currentDate && time === currentTime;

  const toggle = () => setOpen((value) => !value);

  // The trigger stays in the row's action bar; the panel is a full-width flex
  // item that wraps beneath it (order-last), so the bar never collapses.
  const trigger = (
    <Button variant="outline" size="sm" type="button" onClick={toggle}>
      {open ? "Close" : "Reschedule"}
    </Button>
  );

  if (!open) return trigger;

  if (state?.message) {
    return (
      <>
        {trigger}
        <div
          role="status"
          className="order-last flex w-full items-start gap-2.5 rounded-xl border border-teal-200 bg-teal-50 p-3.5 text-sm text-teal-900"
        >
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
          <div>
            <p className="font-medium">Your appointment has moved</p>
            <p className="text-teal-800">{state.message.replace(/^Rescheduled to /, "")}</p>
            <p className="mt-1 text-xs text-teal-700">
              Your existing payment carries over — nothing extra to pay.
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {trigger}
      <form
        action={formAction}
        className="order-last w-full space-y-4 rounded-xl border border-cream-200 bg-cream-50/70 p-4"
      >
        <input type="hidden" name="appointmentId" value={appointmentId} />
        {day && <input type="hidden" name="date" value={day.date} />}
        {selected && <input type="hidden" name="time" value={selected} />}

        <div>
          <p className="text-sm font-semibold text-ink-900">Move this appointment</p>
          <p className="text-xs text-ink-500">
            Currently {currentLabel} · choose a new day and time below
          </p>
        </div>

      <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Choose a day">
        {days.map((option, index) => (
          <button
            key={option.date}
            type="button"
            role="tab"
            aria-selected={index === dayIndex}
            aria-label={`${option.isToday ? "Today" : option.label} — ${selectableTimes(option).length} free slots`}
            onClick={() => {
              setDayIndex(index);
              setSelected(null);
            }}
            className={cn(
              "shrink-0 snap-start rounded-xl border px-3 py-2 text-xs font-medium transition-colors",
              index === dayIndex
                ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                : "border-cream-300 bg-white text-ink-700 hover:border-teal-300 hover:bg-teal-50/50",
              selectableTimes(option).length === 0 && index !== dayIndex && "text-ink-500/70",
            )}
          >
            {option.isToday ? "Today" : option.label}
            <span
              className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]",
                index === dayIndex ? "bg-white/20" : "bg-cream-100 text-ink-500",
              )}
            >
              {selectableTimes(option).length === 0 ? "full" : `${selectableTimes(option).length} free`}
            </span>
          </button>
        ))}
      </div>

      {day && day.times.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {day.times.map((time) => {
            const isSelected = selected === time;
            const isCurrent = isCurrentSlot(day.date, time);
            return (
              <button
                key={time}
                type="button"
                aria-pressed={isSelected}
                disabled={isCurrent}
                aria-label={isCurrent ? `${formatTime(time)} — your current slot` : formatTime(time)}
                title={isCurrent ? "Your current slot" : undefined}
                onClick={() => setSelected(time)}
                className={cn(
                  "flex h-11 items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors",
                  isCurrent
                    ? "cursor-not-allowed flex-col gap-0.5 border-dashed border-cream-300 bg-cream-100 leading-none text-ink-500"
                    : isSelected
                      ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                      : "border-cream-300 bg-white text-ink-800 hover:border-teal-400 hover:bg-teal-50/60",
                )}
              >
                {isSelected && <Check className="h-3.5 w-3.5" />}
                {formatTime(time)}
                {isCurrent && <span className="text-[9px] uppercase tracking-wide">current</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-xl border border-cream-200 bg-white p-3.5 text-xs text-ink-500">
          No free slots on this day. Try another day.
        </p>
      )}

      {day && day.times.length > 0 && selectableTimes(day).length === 0 && (
        <p className="rounded-xl border border-cream-200 bg-white p-3.5 text-xs text-ink-500">
          {formatTime(currentTime)} on this day is already yours — pick another day to move.
        </p>
      )}

      {selected && day && (
        <p className="rounded-xl bg-white px-3.5 py-2.5 text-xs text-ink-600 ring-1 ring-inset ring-cream-200">
          Moving from <span className="font-medium text-ink-800">{currentLabel}</span> to{" "}
          <span className="font-medium text-teal-800">
            {formatDate(day.date)} · {formatTime(selected)}
          </span>
        </p>
      )}

      {state?.error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {state.error}
        </p>
      )}

      {selected && day ? (
        <Button type="submit" size="default" className="w-full" disabled={pending}>
          {pending ? "Moving your appointment…" : "Confirm new slot"}
        </Button>
      ) : (
        <p className="text-center text-xs text-ink-500">Pick a free slot above to confirm.</p>
      )}
      </form>
    </>
  );
}
