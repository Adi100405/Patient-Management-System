"use client";

import { useActionState, useEffect, useState } from "react";
import { updateAvailability, type AvailabilityState } from "@/actions/availability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_CAPACITY } from "@/lib/schedule";
import { formatDate, formatTime } from "@/lib/utils";
import type { AvailabilityRow } from "@/components/availability-manager";

const outcomeLabel = {
  retimed: "Moves with the window",
  moved: "Moved to a new slot",
  needs_rebooking: "Needs a new time",
} as const;

/**
 * The elastic edit for one published window: its bounds and its capacity.
 *
 * The doctor may shrink, move or close the window as far as they like. The
 * first submit is a dry run — it returns exactly which patients would move and
 * where. The second submit applies that impact; it never strands a booking
 * because the server fits every displaced patient into remaining capacity, the
 * next day, or the patient's rebooking queue.
 */
export function AvailabilityEditForm({
  window,
  onDone,
}: {
  window: AvailabilityRow;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState<AvailabilityState, FormData>(
    updateAvailability,
    null,
  );

  // The bounds and capacity are controlled. React resets an uncontrolled form
  // after a server action, and the preview is itself a submit: without this the
  // doctor's just-typed window would snap back to the published one between
  // "Preview impact" and "Confirm".
  const [startTime, setStartTime] = useState(window.startTime);
  const [endTime, setEndTime] = useState(window.endTime);
  const [capacity, setCapacity] = useState(String(window.capacity));
  const [dirty, setDirty] = useState(false);

  // A fresh preview makes the shown impact current again.
  useEffect(() => {
    setDirty(false);
  }, [state?.preview]);

  // A saved edit closes the form: the row above now shows the new window.
  const confirmed = state?.message;
  useEffect(() => {
    if (confirmed) onDone();
  }, [confirmed, onDone]);

  const preview = state?.preview;
  // Editing after a preview makes the shown impact stale: hide it rather than
  // let the doctor confirm one window while another is displayed.
  const shownPreview = dirty ? undefined : preview;

  return (
    <form
      action={formAction}
      className="mt-1 space-y-3 rounded-xl border border-cream-200 bg-cream-50/70 p-3"
    >
      <input type="hidden" name="availabilityId" value={window.id} />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-start-${window.id}`}>From</Label>
          <Input
            id={`edit-start-${window.id}`}
            name="startTime"
            type="time"
            value={startTime}
            onChange={(event) => {
              setStartTime(event.target.value);
              setDirty(true);
            }}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`edit-end-${window.id}`}>To</Label>
          <Input
            id={`edit-end-${window.id}`}
            name="endTime"
            type="time"
            value={endTime}
            onChange={(event) => {
              setEndTime(event.target.value);
              setDirty(true);
            }}
            required
          />
          <p className="text-[11px] text-ink-500">Set the same time as From to close the window.</p>
          {state?.errors?.endTime && (
            <p className="text-xs text-rose-600">{state.errors.endTime}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`edit-capacity-${window.id}`}>
            {window.schedulingType === "wave" ? "Patients per slot" : "Patients in this window"}
          </Label>
          <Input
            id={`edit-capacity-${window.id}`}
            name="capacity"
            type="number"
            min={1}
            max={MAX_CAPACITY}
            value={capacity}
            onChange={(event) => {
              setCapacity(event.target.value);
              setDirty(true);
            }}
            required
          />
          {state?.errors?.capacity && (
            <p className="text-xs text-rose-600">{state.errors.capacity}</p>
          )}
        </div>
      </div>

      {state?.error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {state.error}
        </p>
      )}

      {shownPreview && (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/80 p-3">
          <p className="text-sm font-medium text-amber-900">{shownPreview.summary}</p>

          {shownPreview.rows.length > 0 && (
            <ul className="space-y-1.5">
              {shownPreview.rows.map((row) => (
                <li
                  key={row.appointmentId}
                  className="rounded-lg border border-amber-200/70 bg-white/70 px-2.5 py-2 text-xs text-ink-700"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink-900">{row.patientName}</span>
                    <span className="text-[11px] font-medium uppercase tracking-wide text-amber-800">
                      {outcomeLabel[row.outcome]}
                    </span>
                  </div>
                  <p className="mt-0.5 tabular-nums text-ink-600">
                    {formatDate(row.fromDate)} · {formatTime(row.fromTime)}
                    {row.toDate && row.toTime
                      ? ` → ${formatDate(row.toDate)} · ${formatTime(row.toTime)}`
                      : " → no slot found; patient will be asked to rebook"}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] leading-relaxed text-amber-800">
            Confirming is binding for the clinic. Each patient is notified and can keep the new
            time, reschedule, or cancel. A cancellation of a clinic-moved visit is refunded in
            full.
          </p>
        </div>
      )}

      {preview && dirty && (
        <p className="rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-900">
          These values changed after the last preview. Preview again to see the new impact before
          confirming.
        </p>
      )}

      <p className="text-xs text-ink-500">
        {window.schedulingType === "wave"
          ? "Booked patients keep their place where the window still offers it; everyone else is fitted into remaining capacity or the next available day."
          : "Booked patients keep their queue place. A moved start retimes them; everyone who no longer fits is fitted into another slot."}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" name="mode" value="preview" size="sm" variant="outline" disabled={pending}>
          {pending ? "Checking…" : shownPreview ? "Check again" : "Preview impact"}
        </Button>
        <Button
          type="submit"
          name="mode"
          value="apply"
          size="sm"
          disabled={pending}
          variant={shownPreview ? "default" : "outline"}
        >
          {pending ? "Saving…" : shownPreview ? "Confirm and notify patients" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
