"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { CalendarDays, Check } from "lucide-react";
import { bookAppointment, type BookingState } from "@/actions/booking";
import { Button } from "@/components/ui/button";
import { PaymentCheckout } from "@/components/payment-checkout";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDate, formatTime } from "@/lib/utils";

export type BookingDay = {
  date: string;
  /** "Today" or the weekday, e.g. "Mon". */
  weekday: string;
  /** Short date, e.g. "2 Nov". */
  dayLabel: string;
  slots: { time: string; availabilityId: number }[];
};

/**
 * The booking panel (DESIGN.md §5).
 *
 * Every day and its free slots arrive from the server in one pass, so switching
 * days is instant client state — no navigation, no round trip, no flash. The
 * only thing that reaches the server is the booking itself. The selected day is
 * mirrored into the URL with `replaceState` so the link stays shareable.
 *
 * This replaces the old server-driven list, where every day switch was a full
 * navigation. The server action still re-validates the slot, so a race between
 * render and submit is caught.
 */
export function BookingPanel({
  doctorId,
  days,
  initialDate,
  isSignedIn,
}: {
  doctorId: number;
  days: BookingDay[];
  initialDate: string;
  isSignedIn: boolean;
}) {
  const [state, formAction, pending] = useActionState<BookingState, FormData>(
    bookAppointment,
    null,
  );
  const [activeDate, setActiveDate] = useState(initialDate);
  const [selected, setSelected] = useState<string | null>(null);

  const activeDay = days.find((day) => day.date === activeDate) ?? days[0];
  const selectedSlot = activeDay?.slots.find((slot) => slot.time === selected);

  // Keep the URL shareable without asking the server to re-render.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("date") !== activeDate) {
      url.searchParams.set("date", activeDate);
      window.history.replaceState(null, "", url.toString());
    }
  }, [activeDate]);

  const chooseDay = (date: string) => {
    setActiveDate(date);
    setSelected(null);
  };

  if (state?.message) {
    const time = selected ? formatTime(selected) : "";
    const awaitingPayment = state.payment?.online === true && state.appointmentId !== undefined;

    return (
      <div className="space-y-3 rounded-xl border border-teal-200 bg-teal-50 p-4">
        <p className="text-sm font-medium text-teal-900">
          {awaitingPayment ? "Slot held — complete payment to confirm" : "Appointment booked"}
        </p>
        <p className="text-sm text-teal-800">
          {formatDate(activeDate)} at {time}
        </p>
        {awaitingPayment && state.appointmentId !== undefined && state.payment ? (
          <>
            <p className="text-xs text-teal-800">
              Pay within 15 minutes or the slot is released for other patients.
            </p>
            <PaymentCheckout
              appointmentId={state.appointmentId}
              amount={state.payment.amount}
              currency={state.payment.currency}
            />
            <Link
              href="/dashboard/patient"
              className="block text-xs font-medium text-teal-700 hover:underline"
            >
              Pay later from my appointments
            </Link>
          </>
        ) : (
          <Link href="/dashboard/patient">
            <Button size="sm" type="button">
              Go to my appointments
            </Button>
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
          <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
          Choose a day
        </p>
        <div role="tablist" aria-label="Choose a day" className="flex gap-2 overflow-x-auto pb-1">
          {days.map((day) => {
            const isActive = day.date === activeDay?.date;
            const isFull = day.slots.length === 0;
            return (
              <button
                key={day.date}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => chooseDay(day.date)}
                className={cn(
                  "flex min-w-[4.75rem] shrink-0 flex-col items-center rounded-xl border px-3 py-2 transition duration-150 ease-out active:scale-[0.97]",
                  isActive
                    ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                    : "border-cream-300 bg-white text-ink-800 hover:-translate-y-0.5 hover:border-teal-300 hover:bg-teal-50/50",
                )}
              >
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    isActive ? "text-teal-50" : "text-ink-500",
                  )}
                >
                  {day.weekday}
                </span>
                <span className="mt-0.5 text-sm font-semibold tabular-nums">{day.dayLabel}</span>
                <span
                  className={cn(
                    "mt-1 text-[10px] font-medium",
                    isActive ? "text-teal-50/90" : isFull ? "text-rose-500" : "text-teal-700",
                  )}
                >
                  {isFull ? "Full" : `${day.slots.length} free`}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {activeDay && (
        // Re-mounts per day so the slot grid fades in on every switch.
        <div key={activeDay.date} className="animate-fade-up space-y-4">
          {activeDay.slots.length === 0 ? (
            <p className="rounded-xl border border-cream-200 bg-cream-50/70 p-4 text-sm text-ink-600">
              No free slots left for {formatDate(activeDay.date)}. Try another day.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {activeDay.slots.map((slot) => (
                <button
                  key={slot.time}
                  type="button"
                  onClick={() => setSelected(slot.time)}
                  aria-pressed={selected === slot.time}
                  className={cn(
                    "inline-flex h-11 items-center justify-center gap-1 rounded-xl border px-2 text-xs font-medium tabular-nums transition duration-150 ease-out active:scale-[0.98]",
                    selected === slot.time
                      ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                      : "border-cream-300 bg-white text-ink-800 hover:border-teal-400 hover:bg-teal-50/60",
                  )}
                >
                  {selected === slot.time && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                  {formatTime(slot.time)}
                </button>
              ))}
            </div>
          )}

          {state?.error && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {state.error}
            </p>
          )}

          {!isSignedIn ? (
            <div className="flex flex-col gap-3 rounded-xl border border-cream-200 bg-cream-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink-600">Sign in to confirm this slot.</p>
              <Link href="/sign-in">
                <Button size="sm" type="button">
                  Sign in to book
                </Button>
              </Link>
            </div>
          ) : selectedSlot ? (
            <form action={formAction} className="animate-fade-up space-y-3">
              <input type="hidden" name="doctorId" value={doctorId} />
              <input type="hidden" name="availabilityId" value={selectedSlot.availabilityId} />
              <input type="hidden" name="date" value={activeDay.date} />
              <input type="hidden" name="time" value={selectedSlot.time} />
              <Textarea
                name="reason"
                placeholder="Reason for visit (optional) — e.g. recurring headaches"
                maxLength={300}
              />
              <Button type="submit" className="w-full" loading={pending}>
                {`Confirm ${formatTime(selectedSlot.time)} slot`}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-ink-500">Pick a slot above to continue.</p>
          )}
        </div>
      )}
    </div>
  );
}
