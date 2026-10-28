import { and, asc, desc, eq, gte, lt, ne, or, sql } from "drizzle-orm";
import { cancelAppointment } from "@/actions/booking";
import { getDb } from "@/db";
import { appointments, availability, patients } from "@/db/schema";
import { AppointmentActions } from "@/components/appointment-actions";
import { AvailabilityManager } from "@/components/availability-manager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/session";
import { clinicClock, clinicNow, slotArrived } from "@/lib/slots";
import { formatDate, formatTime } from "@/lib/utils";
import type { AppointmentStatus } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Doctor dashboard — Medrella" };

const statusVariant = {
  booked: "booked",
  cancelled: "cancelled",
  completed: "completed",
  no_show: "no_show",
} as const;

const statusLabel: Record<AppointmentStatus, string> = {
  booked: "booked",
  cancelled: "cancelled",
  completed: "completed",
  no_show: "no-show",
};

type ScheduleRow = {
  readonly id: number;
  readonly date: string;
  readonly time: string;
  readonly status: AppointmentStatus;
  readonly reason: string | null;
  readonly patientName: string;
  readonly patientPhone: string | null;
};

function ScheduleItem({
  row,
  canResolve,
  canCancel,
}: {
  row: ScheduleRow;
  canResolve: boolean;
  canCancel: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="font-medium text-slate-900">{row.patientName}</p>
        <p className="text-sm text-slate-600">
          {formatDate(row.date)} at {formatTime(row.time)}
          {row.patientPhone ? ` · ${row.patientPhone}` : ""}
        </p>
        {row.reason && <p className="text-xs text-slate-500">Reason: {row.reason}</p>}
      </div>
      <div className="flex items-center gap-3">
        <Badge variant={statusVariant[row.status]}>{statusLabel[row.status]}</Badge>
        {canResolve && <AppointmentActions appointmentId={row.id} />}
        {canCancel && (
          <form action={cancelAppointment}>
            <input type="hidden" name="appointmentId" value={row.id} />
            <Button variant="outline" size="sm" type="submit">
              Cancel
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

export default async function DoctorDashboard() {
  const session = await requireRole("doctor");
  const db = getDb();
  // One instant for both reads so date and clock cannot straddle clinic midnight.
  const instant = new Date();
  const now = clinicNow(instant);
  const nowTime = clinicClock(instant);

  const scheduleRows = await db
    .select({
      id: appointments.id,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      status: appointments.status,
      reason: appointments.reason,
      patientName: patients.fullName,
      patientPhone: patients.phone,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .where(
      and(
        eq(appointments.doctorId, session.profileId),
        eq(appointments.status, "booked"),
        gte(appointments.appointmentDate, now.date),
      ),
    )
    .orderBy(asc(appointments.appointmentDate), asc(appointments.appointmentTime))
    .limit(50);

  const historyRows = await db
    .select({
      id: appointments.id,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      status: appointments.status,
      reason: appointments.reason,
      patientName: patients.fullName,
      patientPhone: patients.phone,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .where(
      and(
        eq(appointments.doctorId, session.profileId),
        or(
          lt(appointments.appointmentDate, now.date),
          ne(appointments.status, "booked"),
        ),
      ),
    )
    .orderBy(desc(appointments.appointmentDate), desc(appointments.appointmentTime))
    .limit(50);

  const [stats] = await db
    .select({
      today: sql<number>`count(*) filter (where ${appointments.status} = 'booked' and ${appointments.appointmentDate} = ${now.date})::int`,
      upcoming: sql<number>`count(*) filter (where ${appointments.status} = 'booked' and (${appointments.appointmentDate} > ${now.date} or (${appointments.appointmentDate} = ${now.date} and ${appointments.appointmentTime} > ${nowTime})))::int`,
      patientsSeen: sql<number>`count(distinct ${appointments.patientId}) filter (where ${appointments.status} = 'completed')::int`,
      noShows: sql<number>`count(*) filter (where ${appointments.status} = 'no_show')::int`,
    })
    .from(appointments)
    .where(eq(appointments.doctorId, session.profileId));

  const windows = await db
    .select({
      id: availability.id,
      dayOfWeek: availability.dayOfWeek,
      startTime: availability.startTime,
      endTime: availability.endTime,
      slotMinutes: availability.slotMinutes,
    })
    .from(availability)
    .where(and(eq(availability.doctorId, session.profileId), eq(availability.isActive, true)))
    .orderBy(asc(availability.dayOfWeek), asc(availability.startTime));

  const bookedPerWindow = await db
    .select({ availabilityId: appointments.availabilityId, total: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, session.profileId),
        eq(appointments.status, "booked"),
        gte(appointments.appointmentDate, now.date),
      ),
    )
    .groupBy(appointments.availabilityId);

  const lockedIds = bookedPerWindow
    .filter((row) => row.availabilityId !== null && row.total > 0)
    .map((row) => row.availabilityId as number);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dr. {session.name}</h1>
        <p className="text-sm text-slate-600">
          Appointments booked by patients appear here in real time.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Today", value: stats.today },
          { label: "Upcoming", value: stats.upcoming },
          { label: "Patients seen", value: stats.patientsSeen },
          { label: "No-shows", value: stats.noShows },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-5">
              <p className="text-xs uppercase tracking-wide text-slate-500">{stat.label}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Weekly availability</CardTitle>
          <p className="text-sm text-slate-500">
            Patients can only book inside these windows. Times are clinic time (IST).
          </p>
        </CardHeader>
        <CardContent>
          <AvailabilityManager windows={windows} lockedIds={lockedIds} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <p className="text-sm text-slate-500">
            Booked visits from today onward. Once a visit has happened, mark it
            completed or a no-show.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {scheduleRows.length === 0 ? (
            <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-600">
              No upcoming appointments yet. Patients who book with you will show up here
              instantly.
            </p>
          ) : (
            scheduleRows.map((row) => (
              <ScheduleItem
                key={row.id}
                row={row}
                canResolve={slotArrived(row.date, row.time)}
                canCancel
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <p className="text-sm text-slate-500">
            Past visits and resolved appointments, most recent first.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {historyRows.length === 0 ? (
            <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-600">
              No past appointments yet.
            </p>
          ) : (
            historyRows.map((row) => (
              <ScheduleItem
                key={row.id}
                row={row}
                canResolve={row.status === "booked"}
                canCancel={false}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
