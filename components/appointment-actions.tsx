"use client";

import { useActionState } from "react";
import { resolveAppointment, type ResolveState } from "@/actions/booking";
import { Button } from "@/components/ui/button";

/** Complete / No-show controls for a booked visit whose slot has arrived. */
export function AppointmentActions({ appointmentId }: { appointmentId: number }) {
  const [state, formAction, pending] = useActionState<ResolveState, FormData>(
    resolveAppointment,
    null,
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <form action={formAction}>
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <input type="hidden" name="intent" value="complete" />
          <Button size="sm" type="submit" disabled={pending}>
            Complete
          </Button>
        </form>
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
