"use client";

import { useActionState, useState } from "react";
import { resolveAppointment, type ResolveState } from "@/actions/booking";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Complete / No-show controls for a booked visit whose slot has arrived.
 *
 * Completing a visit can carry care forward: an optional aftercare note the
 * patient sees on their dashboard, and an optional follow-up interval that
 * schedules a gentle nudge later. Both are optional, so a plain "complete"
 * stays one click — the care fields only appear once the doctor asks for them.
 */
export function AppointmentActions({ appointmentId }: { appointmentId: number }) {
  const [state, formAction, pending] = useActionState<ResolveState, FormData>(
    resolveAppointment,
    null,
  );
  const [showCare, setShowCare] = useState(false);

  if (!showCare) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <Button size="sm" type="button" onClick={() => setShowCare(true)} disabled={pending}>
            Complete
          </Button>
          <form action={formAction}>
            <input type="hidden" name="appointmentId" value={appointmentId} />
            <input type="hidden" name="intent" value="no_show" />
            <Button variant="outline" size="sm" type="submit" disabled={pending}>
              No-show
            </Button>
          </form>
        </div>
        {state?.error && <p className="text-xs text-rose-600">{state.error}</p>}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="w-72 space-y-3 rounded-xl border border-cream-200 bg-white p-3.5 text-left"
    >
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="intent" value="complete" />

      <div className="space-y-1.5">
        <Label htmlFor={`aftercare-${appointmentId}`}>Aftercare instructions</Label>
        <Textarea
          id={`aftercare-${appointmentId}`}
          name="aftercare"
          rows={3}
          placeholder="Rest, hydration, when to return…"
        />
        <p className="text-xs text-ink-500">
          Optional. Shown to the patient on their dashboard — never sent by email or text.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`follow-up-${appointmentId}`}>Recommend a follow-up in (days)</Label>
        <Input
          id={`follow-up-${appointmentId}`}
          name="followUpDays"
          type="number"
          min={1}
          max={365}
          inputMode="numeric"
          placeholder="e.g. 14"
        />
        <p className="text-xs text-ink-500">Optional. Leave blank for no follow-up nudge.</p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowCare(false)}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Mark completed"}
        </Button>
      </div>

      {state?.error && <p className="text-xs text-rose-600">{state.error}</p>}
    </form>
  );
}
