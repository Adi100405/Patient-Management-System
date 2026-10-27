"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { bookAppointment, type BookingState } from "@/actions/booking";
import { Button } from "@/components/ui/button";
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
    return (
      <div className="space-y-3 rounded-lg border border-teal-200 bg-teal-50 p-4">
        <p className="text-sm font-medium text-teal-900">Appointment confirmed 🎉</p>
        <p className="text-sm text-teal-800">
          {formatDate(date)} at {formatTime(state.message.split(" at ")[1] ?? "")}
        </p>
        <Link href="/dashboard/patient">
          <Button size="sm" type="button">
            Go to my appointments
          </Button>
        </Link>
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
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
            className={`rounded-lg border px-2 py-2 text-xs font-medium transition ${
              selected === slot.time
                ? "border-teal-600 bg-teal-600 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:border-teal-400 hover:bg-teal-50"
            }`}
          >
            {formatTime(slot.time)}
          </button>
        ))}
      </div>

      {state?.error && (
        <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{state.error}</p>
      )}

      {!isSignedIn ? (
        <div className="space-y-2 rounded-lg bg-slate-50 p-4">
          <p className="text-sm text-slate-600">Sign in to confirm your appointment.</p>
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
        <p className="text-sm text-slate-500">Pick a slot above to continue.</p>
      )}
    </div>
  );
}
