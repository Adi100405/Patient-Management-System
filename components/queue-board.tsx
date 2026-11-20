import Link from "next/link";
import { Check, CircleSlash, Clock, LogIn, Users } from "lucide-react";
import { AppointmentActions } from "@/components/appointment-actions";
import { CallNextButton, CheckInButton, NoShowButton } from "@/components/queue-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildQueue, checkInWindow, formatClinicTime } from "@/lib/queue";
import type { DoctorQueueRow } from "@/lib/queue-data";
import { slotArrived } from "@/lib/slots";
import { formatTime } from "@/lib/utils";

/**
 * The desk board for one doctor on one day.
 *
 * The order people see here is the order they checked in. Positions are worked
 * out every time the board is drawn, so a cancellation or a no-show closes the
 * gap by itself — there is no stored rank that can go stale. Tokens are the
 * opposite: they stay with the patient for the whole day.
 *
 * The board has two faces. The doctor calls people in and closes the visit;
 * the front desk checks them in and closes the visits that were never
 * attended. The mode decides which buttons each of them gets.
 */
export function QueueBoard({
  date,
  rows,
  mode,
}: {
  date: string;
  rows: readonly DoctorQueueRow[];
  mode: "doctor" | "reception";
}) {
  const view = buildQueue(rows);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const completed = view.done.filter((entry) => entry.state === "done").length;
  const serving = view.serving;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Today&rsquo;s queue</CardTitle>
            <p className="text-sm text-ink-500">
              {mode === "doctor"
                ? "Patients in the order they checked in. Call one in when you are ready."
                : "Patients in the order they checked in. Check them in as they arrive."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 font-medium tabular-nums ring-1 ring-inset ring-cream-200">
              <Users className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />
              {view.waiting.length} waiting
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 font-medium tabular-nums ring-1 ring-inset ring-cream-200">
              <LogIn className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />
              {view.notCheckedIn.length} not checked in
            </span>
            {completed > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 font-medium tabular-nums ring-1 ring-inset ring-cream-200">
                <Check className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />
                {completed} done
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            In the room
          </h3>
          {serving ? (
            <div className="flex flex-col gap-3 rounded-xl border border-teal-200 bg-teal-50/60 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-700 text-xs font-semibold text-white">
                  {serving.token ?? "—"}
                </span>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-ink-900">
                      {byId.get(serving.id)?.patientName ?? "Patient"}
                    </p>
                    {mode === "doctor" && (
                      <RecordLink patientId={byId.get(serving.id)?.patientId} />
                    )}
                  </div>
                  <p className="text-xs text-ink-600">
                    {formatTime(serving.appointmentTime)}
                    {serving.checkedInAt && (
                      <>
                        {" · "}
                        checked in {formatClinicTime(serving.checkedInAt)}
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="serving">Being seen</Badge>
                {mode === "doctor" && <AppointmentActions appointmentId={serving.id} />}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink-600">
                {mode === "doctor"
                  ? "Nobody is in the room. Call the next patient in when you are ready."
                  : "Nobody is in the room. The doctor calls the next patient in."}
              </p>
              {mode === "doctor" && <CallNextButton disabled={view.waiting.length === 0} />}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Waiting
          </h3>
          {view.waiting.length === 0 ? (
            <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-4 text-sm text-ink-500">
              Nobody is waiting. Patients appear here the moment they check in.
            </p>
          ) : (
            <ul className="space-y-2">
              {view.waiting.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-col gap-2 rounded-xl border border-cream-200 bg-white p-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cream-100 text-xs font-semibold tabular-nums text-ink-700 ring-1 ring-inset ring-cream-200">
                      #{entry.position}
                    </span>
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-ink-900">
                          {byId.get(entry.id)?.patientName ?? "Patient"}
                        </p>
                        {mode === "doctor" && (
                          <RecordLink patientId={byId.get(entry.id)?.patientId} />
                        )}
                      </div>
                      <p className="text-xs text-ink-600">
                        <span className="tabular-nums">
                          {formatTime(entry.appointmentTime)}
                        </span>
                        {entry.checkedInAt && (
                          <>
                            {" · checked in "}
                            {formatClinicTime(entry.checkedInAt)}
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="waiting">Token {entry.token ?? "—"}</Badge>
                    {mode === "doctor" && slotArrived(date, entry.appointmentTime) && (
                      <AppointmentActions appointmentId={entry.id} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Not checked in
          </h3>
          {view.notCheckedIn.length === 0 ? (
            <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-4 text-sm text-ink-500">
              Everyone booked for today is at the desk.
            </p>
          ) : (
            <ul className="space-y-2">
              {view.notCheckedIn.map((entry) => {
                const window = checkInWindow(date, entry.appointmentTime);
                const arrived = slotArrived(date, entry.appointmentTime);
                return (
                  <li
                    key={entry.id}
                    className="flex flex-col gap-2 rounded-xl border border-cream-200 bg-white p-3.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cream-100 text-ink-400 ring-1 ring-inset ring-cream-200">
                        <Clock className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <div className="space-y-1">
                        <p className="font-semibold text-ink-900">
                          {byId.get(entry.id)?.patientName ?? "Patient"}
                        </p>
                        <p className="text-xs text-ink-600">
                          <span className="tabular-nums">
                            {formatTime(entry.appointmentTime)}
                          </span>
                          {window.state === "before" && (
                            <> · check-in opens at {window.opensAt}</>
                          )}
                          {arrived && (
                            <>
                              {" · "}
                              <CircleSlash
                                className="inline h-3 w-3 text-amber-600"
                                aria-hidden="true"
                              />{" "}
                              slot has passed
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {mode === "doctor" ? (
                        arrived && <AppointmentActions appointmentId={entry.id} />
                      ) : (
                        <>
                          {window.state === "open" && <CheckInButton appointmentId={entry.id} />}
                          {arrived && <NoShowButton appointmentId={entry.id} />}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/** A doctor-facing shortcut to the patient's record; the front desk never gets one. */
function RecordLink({ patientId }: { patientId: number | undefined }) {
  if (patientId === undefined) return null;
  return (
    <Link
      href={`/dashboard/doctor/patients/${patientId}`}
      className="rounded-full border border-cream-300 px-2 py-0.5 text-[11px] font-medium text-teal-700 transition-colors hover:border-teal-300 hover:bg-teal-50"
    >
      Patient record
    </Link>
  );
}
