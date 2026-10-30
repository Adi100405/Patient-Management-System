"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { bookAppointment, type BookingState } from "@/actions/booking";
import { Button } from "@/components/ui/button";
import { PaymentCheckout } from "@/components/payment-checkout";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatTime } from "@/lib/utils";

type Slot = { time: string; availabilityId: number };

export function SlotPicker({
  doctorId,
  date,
  slots,
  isSignedIn,
}: {
  doctorId: number;
  date: string;
  slots: Slot[];
  isSignedIn: boolean;
}) {
  const [state, formAction, pending] = useActionState<BookingState, FormData>(
    bookAppointment,
    null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const selectedSlot = slots.find((slot) => slot.time === selected);

  if (state?.message) {
    // Read the time from the picked value, not from `slots`: the booking
    // revalidates the page and the slot we just took is no longer offered.
    const time = selected ? formatTime(selected) : "";
    const awaitingPayment = state.payment?.online === true && state.appointmentId !== undefined;

    return (
      <div className="space-y-3 rounded-xl border border-teal-200 bg-teal-50 p-4">
        <p className="text-sm font-medium text-teal-900">
          {awaitingPayment ? "Slot held — complete payment to confirm" : "Appointment booked 🎉"}
        </p>
        <p className="text-sm text-teal-800">
          {formatDate(date)} at {time}
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
            <Link href="/dashboard/patient" className="block text-xs font-medium text-teal-700 hover:underline">
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

  if (slots.length === 0) {
    return (
      <p className="rounded-xl border border-cream-200 bg-cream-50/70 p-4 text-sm text-ink-600">
        No free slots left for {formatDate(date)}. Try another day.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {slots.map((slot) => (
          <button
            key={slot.time}
            type="button"
            onClick={() => setSelected(slot.time)}
            className={`h-11 rounded-xl border px-2 text-xs font-medium transition-colors ${
              selected === slot.time
                ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                : "border-cream-300 bg-white text-ink-800 hover:border-teal-400 hover:bg-teal-50/60"
            }`}
          >
            {formatTime(slot.time)}
          </button>
        ))}
      </div>

      {state?.error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{state.error}</p>
      )}

      {!isSignedIn ? (
        <div className="space-y-2 rounded-xl border border-cream-200 bg-cream-50/70 p-4">
          <p className="text-sm text-ink-600">Sign in to confirm your appointment.</p>
          <Link href="/sign-in">
            <Button size="sm" type="button">
              Sign in to book
            </Button>
          </Link>
        </div>
      ) : selectedSlot ? (
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="doctorId" value={doctorId} />
          <input type="hidden" name="availabilityId" value={selectedSlot.availabilityId} />
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="time" value={selectedSlot.time} />
          <Textarea
            name="reason"
            placeholder="Reason for visit (optional) — e.g. recurring headaches"
            maxLength={300}
          />
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Booking…" : `Confirm ${formatTime(selectedSlot.time)} slot`}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-ink-500">Pick a slot above to continue.</p>
      )}
    </div>
  );
}
