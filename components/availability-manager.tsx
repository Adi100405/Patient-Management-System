"use client";

import { useActionState } from "react";
import {
  addAvailability,
  removeAvailability,
  type AvailabilityState,
} from "@/actions/availability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTime } from "@/lib/utils";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type AvailabilityRow = {
  id: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
};

const selectClass =
  "flex h-10 w-full rounded-xl border border-cream-300 bg-white px-3 text-sm text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600";

export function AvailabilityManager({
  windows,
  lockedIds,
}: {
  windows: AvailabilityRow[];
  lockedIds: number[];
}) {
  const [state, formAction, pending] = useActionState<AvailabilityState, FormData>(
    addAvailability,
    null,
  );
  const locked = new Set(lockedIds);

  return (
    <div className="space-y-5">
      {windows.length === 0 ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          You haven&apos;t published any availability yet, so patients can&apos;t book you.
          Add your first window below.
        </p>
      ) : (
        <ul className="space-y-2">
          {windows.map((window) => (
            <li
              key={window.id}
              className="flex flex-col gap-2 rounded-xl border border-cream-200 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium text-ink-900">
                  {DAYS[window.dayOfWeek]} · {formatTime(window.startTime)} –{" "}
                  {formatTime(window.endTime)}
                </p>
                <p className="text-xs text-ink-500">{window.slotMinutes} minute slots</p>
              </div>

              {locked.has(window.id) ? (
                <span className="text-xs font-medium text-ink-500">
                  Has upcoming bookings — cancel them to remove
                </span>
              ) : (
                <form action={removeAvailability}>
                  <input type="hidden" name="availabilityId" value={window.id} />
                  <Button variant="outline" size="sm" type="submit">
                    Remove
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {state?.message && (
        <p className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">{state.message}</p>
      )}
      {state?.error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{state.error}</p>
      )}

      <form
        key={windows.length}
        action={formAction}
        className="grid gap-3 rounded-xl border border-dashed border-cream-300 bg-cream-50/70 p-4 sm:grid-cols-5"
      >
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="dayOfWeek">Day</Label>
          <select id="dayOfWeek" name="dayOfWeek" className={selectClass} defaultValue="1">
            {DAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="startTime">From</Label>
          <Input id="startTime" name="startTime" type="time" defaultValue="09:00" required />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="endTime">To</Label>
          <Input id="endTime" name="endTime" type="time" defaultValue="13:00" required />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="slotMinutes">Slot</Label>
          <select id="slotMinutes" name="slotMinutes" className={selectClass} defaultValue="30">
            <option value="15">15 min</option>
            <option value="30">30 min</option>
            <option value="45">45 min</option>
            <option value="60">60 min</option>
          </select>
        </div>

        {state?.errors?.endTime && (
          <p className="text-xs text-rose-600 sm:col-span-5">{state.errors.endTime}</p>
        )}

        <div className="sm:col-span-5">
          <Button type="submit" disabled={pending} size="sm">
            {pending ? "Adding…" : "Add availability window"}
          </Button>
        </div>
      </form>
    </div>
  );
}
