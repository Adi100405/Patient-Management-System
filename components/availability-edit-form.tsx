"use client";

import { useActionState, useEffect } from "react";
import { updateAvailability, type AvailabilityState } from "@/actions/availability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_CAPACITY } from "@/lib/schedule";
import type { AvailabilityRow } from "@/components/availability-manager";

/**
 * The elastic edit for one published window: its bounds and its capacity.
 *
 * The scheduling style and visit length were fixed when the block was
 * published — reshaping a wave's slot grid could strand booked visits
 * mid-grid — so only these three fields move. Every booked visit keeps
 * standing where it is: the server refuses an edit that would drop one,
 * naming the visit that blocks it.
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

  // A saved edit closes the form: the row above now shows the new window.
  const confirmed = state?.message;
  useEffect(() => {
    if (confirmed) onDone();
  }, [confirmed, onDone]);

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
            defaultValue={window.startTime}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`edit-end-${window.id}`}>To</Label>
          <Input
            id={`edit-end-${window.id}`}
            name="endTime"
            type="time"
            defaultValue={window.endTime}
            required
          />
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
            defaultValue={window.capacity}
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

      <p className="text-xs text-ink-500">
        {window.schedulingType === "wave"
          ? "Booked visits keep their start times — an edit that would drop one is refused."
          : "Booked patients keep their start and queue place; they are told when the window's end moves."}
      </p>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
