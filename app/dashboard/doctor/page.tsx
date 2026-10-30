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
  booked: "Booked",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
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
    <div className="flex flex-col gap-3 rounded-xl border border-cream-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-teal-50 text-xs font-semibold text-teal-800 ring-1 ring-inset ring-teal-100"
        >
          {initials(row.patientName)}
        </span>
        <div className="space-y-1">
          <p className="font-semibold text-ink-900">{row.patientName}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium text-ink-700">
              <CalendarIcon className="h-3.5 w-3.5 text-ink-500" />
              {formatDate(row.date)} · {formatTime(row.time)}
            </span>
            {row.patientPhone && (
              <span className="text-xs text-ink-500">{row.patientPhone}</span>
            )}
          </div>
          {row.reason && (
            <p className="text-xs text-ink-500">
              Reason: <span className="text-ink-700">{row.reason}</span>
            </p>
          )}
        </div>
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
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Dr. {session.name}</h1>
        <p className="text-sm text-ink-500">
          Appointments booked by patients appear here in real time.
        </p>
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 divide-cream-200 sm:grid-cols-4 sm:divide-x">
          {[
            { label: "Today", value: stats.today, tone: "text-teal-800", icon: <CalendarIcon /> },
            { label: "Upcoming", value: stats.upcoming, tone: "text-ink-900", icon: <ClockIcon /> },
            { label: "Patients seen", value: stats.patientsSeen, tone: "text-teal-800", icon: <PeopleIcon /> },
            { label: "No-shows", value: stats.noShows, tone: "text-rose-700", icon: <AlertIcon /> },
          ].map((stat) => (
            <div key={stat.label} className="flex items-center gap-3 p-4 sm:p-5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cream-100 text-ink-500">
                {stat.icon}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase leading-tight tracking-wide text-ink-500">
                  {stat.label}
                </p>
                <p className={`mt-0.5 text-xl font-semibold tabular-nums ${stat.tone}`}>{stat.value}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Weekly availability</CardTitle>
          <p className="text-sm text-ink-500">
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
          <p className="text-sm text-ink-500">
            Booked visits from today onward. Once a visit has happened, mark it
            completed or a no-show.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {scheduleRows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-6 text-center">
              <p className="text-sm font-medium text-ink-800">No upcoming appointments yet</p>
              <p className="mt-1 text-sm text-ink-500">
                Patients who book with you will show up here instantly.
              </p>
            </div>
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
          <p className="text-sm text-ink-500">
            Past visits and resolved appointments, most recent first.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {historyRows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-5 text-sm text-ink-500">
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

/** "Riya Sharma" -> "RS" — the same human marker patients see for their doctor. */
function initials(fullName: string) {
  return fullName
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function CalendarIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm10.75 6.5H3.5v6.75c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V8.5Z" />
    </svg>
  );
}

function ClockIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v3.5c0 .2.08.39.22.53l2.25 2.25a.75.75 0 1 0 1.06-1.06l-2.03-2.03V6.75Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function PeopleIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M7.5 9.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM2 15.25c0-2 2.24-3.75 5.5-3.75s5.5 1.75 5.5 3.75V16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-.75Zm12.5-6.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Zm.5 1.5c-.6 0-1.17.08-1.68.23.9.87 1.48 2 1.58 3.27H18a1 1 0 0 0 1-1v-.5c0-1.66-1.79-3-4-3Z" />
    </svg>
  );
}

function AlertIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-11.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6.5Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
