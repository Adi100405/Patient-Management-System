"use client";

import { useActionState, useState } from "react";
import {
  callNextPatient,
  checkInAppointment,
  markNoShowAtDesk,
  type QueueActionState,
} from "@/actions/checkin";
import { Button } from "@/components/ui/button";

/**
 * The buttons that move the queue.
 *
 * They are client components because the desk needs to see the button
 * working straight away: a check-in that looks like it did nothing is worse
 * than one that says it did nothing.
 */
export function CheckInButton({ appointmentId }: { appointmentId: number }) {
  const [state, formAction, pending] = useActionState<QueueActionState, FormData>(
    checkInAppointment,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <Button size="sm" type="submit" disabled={pending} loading={pending}>
        {pending ? "Checking in…" : "Check in"}
      </Button>
      {state?.error && <p className="text-xs text-rose-600">{state.error}</p>}
    </form>
  );
}

/**
 * Calls the next waiting patient in.
 *
 * The button says why it cannot be used, rather than sitting there greyed out
 * with no explanation.
 */
export function CallNextButton({ disabled }: { disabled: boolean }) {
  const [state, setState] = useState<QueueActionState>(null);
  const [pending, setPending] = useState(false);

  async function call() {
    setPending(true);
    try {
      setState(await callNextPatient());
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        type="button"
        disabled={pending || disabled}
        loading={pending}
        onClick={() => {
          void call();
        }}
      >
        {pending ? "Calling…" : "Call next"}
      </Button>
      {state?.error && <p className="text-xs text-rose-600">{state.error}</p>}
    </div>
  );
}

/**
 * Records that a patient never turned up.
 *
 * This is the front desk's own outcome, for a visit whose slot time has
 * passed and which nobody ever checked in. A patient who did check in and
 * then left is the doctor's to close.
 */
export function NoShowButton({ appointmentId }: { appointmentId: number }) {
  const [state, formAction, pending] = useActionState<QueueActionState, FormData>(
    markNoShowAtDesk,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <Button variant="outline" size="sm" type="submit" disabled={pending}>
        {pending ? "Saving…" : "No-show"}
      </Button>
      {state?.error && <p className="text-xs text-rose-600">{state.error}</p>}
    </form>
  );
}
