import { asc } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import { QueueBoard } from "@/components/queue-board";
import { Card, CardContent } from "@/components/ui/card";
import { buildQueue } from "@/lib/queue";
import { doctorQueueForDate } from "@/lib/queue-data";
import { requireRole } from "@/lib/session";
import { clinicNow } from "@/lib/slots";

export const dynamic = "force-dynamic";
export const metadata = { title: "Front desk — Medrella" };

/**
 * The front desk.
 *
 * The doctor does not sit at reception, so this is where a patient arrives:
 * the receptionist checks them in, hands them a token and records the visits
 * nobody attended. The doctor calls them in and closes the visit, so neither
 * button is offered here.
 *
 * The desk covers the whole clinic. There is no clinic entity and no
 * per-doctor mapping — every doctor has a board here, and the receptionist
 * works all of them.
 */
export default async function ReceptionDashboard() {
  await requireRole("receptionist");
  const now = clinicNow();
  const db = getDb();

  const doctorRows = await db
    .select({ id: doctors.id, fullName: doctors.fullName })
    .from(doctors)
    .orderBy(asc(doctors.fullName));

  // One read per doctor, all at once: the desk sees every queue in the clinic.
  const boards = await Promise.all(
    doctorRows.map(async (doctor) => ({
      doctor,
      rows: await doctorQueueForDate(doctor.id, now.date),
    })),
  );

  // A doctor whose only visits are waiting for a new time has nothing at the
  // desk today — those patients are not coming in.
  const live = boards
    .map((board) => ({ ...board, view: buildQueue(board.rows) }))
    .filter((board) => board.rows.some((row) => row.status !== "needs_rebooking"));

  const visits = live.reduce(
    (total, board) =>
      total +
      board.view.notCheckedIn.length +
      board.view.waiting.length +
      (board.view.serving ? 1 : 0),
    0,
  );
  const waiting = live.reduce((total, board) => total + board.view.waiting.length, 0);
  const inRoom = live.filter((board) => board.view.serving).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Front desk</h1>
        <p className="text-sm text-ink-500">
          Check patients in for any doctor. The doctor calls them in and closes the visit.
        </p>
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-3 divide-cream-200">
          {[
            { label: "Visits today", value: visits },
            { label: "Waiting", value: waiting },
            { label: "In the room", value: inRoom },
          ].map((stat) => (
            <div key={stat.label} className="flex flex-col gap-1 p-4 sm:p-5">
              <p className="text-[11px] font-medium uppercase leading-tight tracking-wide text-ink-500">
                {stat.label}
              </p>
              <p className="text-xl font-semibold tabular-nums text-ink-900">{stat.value}</p>
            </div>
          ))}
        </div>
      </Card>

      {live.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm font-medium text-ink-800">No visits are booked for today</p>
            <p className="mt-1 text-sm text-ink-500">
              When a patient books a visit, it appears here ready to be checked in.
            </p>
          </CardContent>
        </Card>
      ) : (
        live.map((board) => (
          <section key={board.doctor.id} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold tracking-tight text-ink-900">
                Dr. {board.doctor.fullName}
              </h2>
              <p className="text-sm text-ink-500">
                {board.view.waiting.length} waiting
                {board.view.serving ? " · one in the room" : ""}
              </p>
            </div>
            <QueueBoard date={now.date} rows={board.rows} mode="reception" />
          </section>
        ))
      )}
    </div>
  );
}
