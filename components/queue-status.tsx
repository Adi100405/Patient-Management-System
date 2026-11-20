import { CircleCheck, Info, Ticket, UserRound } from "lucide-react";
import { checkInWindow, formatClinicTime, positionLabel } from "@/lib/queue";
import type { PatientQueueStatus } from "@/lib/queue-data";

/**
 * What the patient is told about their own place in the queue.
 *
 * Only their own visit is described: the token, the moment they checked in and
 * their place in line. Nobody else's name is on this screen, and the moment
 * they are called in the line reads as one.
 */
export function QueueStatus({
  status,
  date,
  time,
}: {
  status: PatientQueueStatus | null;
  date: string;
  time: string;
}) {
  if (!status) return null;

  if (status.state === "serving") {
    return (
      <p className="flex flex-wrap items-center gap-2 rounded-lg bg-teal-50 px-3 py-2 text-xs font-medium text-teal-800 ring-1 ring-inset ring-teal-200">
        <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
        You are being seen now
        {status.token && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 tabular-nums ring-1 ring-inset ring-teal-200">
            <Ticket className="h-3 w-3" aria-hidden="true" />
            {status.token}
          </span>
        )}
      </p>
    );
  }

  if (status.state === "waiting") {
    return (
      <p className="flex flex-wrap items-center gap-2 rounded-lg bg-cream-100 px-3 py-2 text-xs text-ink-700 ring-1 ring-inset ring-cream-200">
        <Ticket className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />
        <span className="font-medium text-ink-800">
          Checked in at {status.checkedInAt ? formatClinicTime(status.checkedInAt) : "the desk"}
        </span>
        {status.token && <span className="tabular-nums">· Token {status.token}</span>}
        {positionLabel(status.position) && (
          <span className="font-medium text-teal-700">· {positionLabel(status.position)}</span>
        )}
      </p>
    );
  }

  if (status.state === "not_checked_in") {
    const window = checkInWindow(date, time);
    return (
      <p className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="font-medium">Not checked in yet</span>
        {window.state === "before" ? (
          <span>· check-in opens at {window.opensAt}</span>
        ) : (
          <span>· the clinic desk will check you in when you arrive</span>
        )}
      </p>
    );
  }

  if (!status.checkedInAt) return null;

  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
      <CircleCheck className="h-3.5 w-3.5 text-teal-600" aria-hidden="true" />
      Checked in at {formatClinicTime(status.checkedInAt)}
    </p>
  );
}
