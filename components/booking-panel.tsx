"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { CalendarDays, Check } from "lucide-react";
import { bookAppointment, type BookingState } from "@/actions/booking";
import { Button } from "@/components/ui/button";
import { PaymentCheckout } from "@/components/payment-checkout";
import { Textarea } from "@/components/ui/textarea";
import { visitWhenLabel, type SchedulingType } from "@/lib/schedule";
import { cn, formatDate } from "@/lib/utils";

export type BookingSlot = {
  time: string;
  /** Where the bookable item ends — a stream window's end; null for a wave slot. */
  endTime: string | null;
  availabilityId: number;
  schedulingType: SchedulingType;
  /** How many patients the slot holds in total. */
  seats: number;
  /** How many of those seats are still free. */
  free: number;
};

export type BookingDay = {
  date: string;
  /** "Today" or the weekday, e.g. "Mon". */
  weekday: string;
  /** Short date, e.g. "2 Nov". */
  dayLabel: string;
  /** Every free seat on this day, across all its slots. */
  freeSeats: number;
  slots: BookingSlot[];
};

/**
 * The booking panel (DESIGN.md §5).
 *
 * Every day and its free slots arrive from the server in one pass, so switching
 * days is instant client state — no navigation, no round trip, no flash. The
 * only thing that reaches the server is the booking itself. The selected day is
 * mirrored into the URL so the link stays shareable.
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
  // The chosen slot, held as a snapshot. After the last seat of a window is
  // booked, the refreshed server data no longer lists it — the success screen
  // must still speak the range the patient actually chose.
  const [selected, setSelected] = useState<BookingSlot | null>(null);

  const activeDay = days.find((day) => day.date === activeDate) ?? days[0];

  // Keep the URL shareable without involving the Next router.
  //
  // Next.js patches `history.replaceState` so a URL change re-renders the
  // server tree. For a client-side day picker that is the wrong trade: the
  // round trip can land after the patient has already moved on, and the
  // re-render resets the day that was just chosen. The native History API
  // updates the address bar and nothing else — and because the URL then
  // carries the chosen day, even a remount lands on the right day.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("date") === activeDate) return;

    url.searchParams.set("date", activeDate);
    const nativeHistory = Object.getPrototypeOf(window.history) as {
      replaceState: (data: unknown, title: string, url?: string | null) => void;
    };
    nativeHistory.replaceState.call(window.history, null, "", url.toString());
  }, [activeDate]);

  const chooseDay = (date: string) => {
    setActiveDate(date);
    setSelected(null);
  };

  if (state?.message) {
    const when = selected ? whenLabel(selected) : "";
    const awaitingPayment = state.payment?.online === true && state.appointmentId !== undefined;

    return (
      <div className="space-y-3 rounded-xl border border-teal-200 bg-teal-50 p-4">
        <p className="text-sm font-medium text-teal-900">
          {awaitingPayment ? "Slot held — complete payment to confirm" : "Appointment booked"}
        </p>
        <p className="text-sm text-teal-800">
          {selected?.schedulingType === "stream"
            ? `${formatDate(activeDate)} · ${when}`
            : `${formatDate(activeDate)} at ${when}`}
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
            const isFull = day.freeSeats === 0;
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
                  {isFull ? "Full" : `${day.freeSeats} free`}
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
              {activeDay.slots.map((slot) => {
                const isSelected = selected?.time === slot.time;
                const isStream = slot.schedulingType === "stream";

                if (isStream) {
                  // A stream window books as one item: it owns the whole row and
                  // reads as a start–end range, not a list of per-position times.
                  return (
                    <button
                      key={slot.time}
                      type="button"
                      onClick={() => setSelected(slot)}
                      aria-pressed={isSelected}
                      aria-label={slotLabel(slot)}
                      className={cn(
                        "col-span-3 flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl border px-3 py-2 text-xs font-medium transition duration-150 ease-out active:scale-[0.98] sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4",
                        isSelected
                          ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                          : "border-cream-300 bg-white text-ink-800 hover:border-teal-400 hover:bg-teal-50/60",
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5 tabular-nums">
                        {isSelected && <Check className="h-3 w-3" aria-hidden="true" />}
                        <span className="text-sm font-semibold">{whenLabel(slot)}</span>
                      </span>
                      {slotNote(slot) && (
                        <span className="text-[9px] font-semibold uppercase tracking-wide opacity-75 sm:text-[10px]">
                          {slotNote(slot)}
                        </span>
                      )}
                    </button>
                  );
                }

                return (
                  <button
                    key={slot.time}
                    type="button"
                    onClick={() => setSelected(slot)}
                    aria-pressed={isSelected}
                    aria-label={slotLabel(slot)}
                    className={cn(
                      "inline-flex h-12 flex-col items-center justify-center gap-0.5 rounded-xl border px-1 text-xs font-medium tabular-nums transition duration-150 ease-out active:scale-[0.98]",
                      isSelected
                        ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                        : "border-cream-300 bg-white text-ink-800 hover:border-teal-400 hover:bg-teal-50/60",
                    )}
                  >
                    <span className="inline-flex items-center gap-1">
                      {isSelected && <Check className="h-3 w-3" aria-hidden="true" />}
                      {whenLabel(slot)}
                    </span>
                    {slotNote(slot) && (
                      <span className="text-[9px] font-semibold uppercase tracking-wide opacity-75">
                        {slotNote(slot)}
                      </span>
                    )}
                  </button>
                );
              })}
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
          ) : selected ? (
            <form action={formAction} className="animate-fade-up space-y-3">
              <input type="hidden" name="doctorId" value={doctorId} />
              <input type="hidden" name="availabilityId" value={selected.availabilityId} />
              <input type="hidden" name="date" value={activeDay.date} />
              <input type="hidden" name="time" value={selected.time} />
              <Textarea
                name="reason"
                placeholder="Reason for visit (optional) — e.g. recurring headaches"
                maxLength={300}
              />
              <Button type="submit" className="w-full" loading={pending}>
                {`Confirm ${whenLabel(selected)} ${
                  selected.schedulingType === "stream" ? "window" : "slot"
                }`}
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

/** What the tile's time reads as: a stream's full span, a wave's start time. */
function whenLabel(slot: BookingSlot) {
  return visitWhenLabel({
    schedulingType: slot.schedulingType,
    time: slot.time,
    windowEnd: slot.endTime,
  });
}

/**
 * The note under a bookable item: what it is and how many places are left. A
 * wave with room for one patient needs no note — it reads as a plain
 * appointment.
 */
function slotNote(slot: BookingSlot) {
  if (slot.schedulingType === "stream") {
    return `Stream window · ${slot.free} of ${slot.seats} places left`;
  }
  if (slot.seats > 1) return `${slot.free} left`;
  return null;
}

/** What a screen reader hears for a bookable item, seats included. */
function slotLabel(slot: BookingSlot) {
  const when = whenLabel(slot);
  if (slot.schedulingType === "stream") {
    return `${when} stream window, ${slot.free} of ${slot.seats} places left`;
  }
  if (slot.seats > 1) return `${when} — ${slot.free} of ${slot.seats} places left`;
  return when;
}
