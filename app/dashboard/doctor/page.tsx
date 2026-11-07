import { and, asc, desc, eq, gte, lt, ne, or, sql } from "drizzle-orm";
import { AlertTriangle, Calendar, Clock, Users } from "lucide-react";
import { getDb } from "@/db";
import { appointments, availability, patients } from "@/db/schema";
import { AppointmentActions } from "@/components/appointment-actions";
import { AvailabilityManager, type AvailabilityRow } from "@/components/availability-manager";
import { CancelAppointment } from "@/components/cancel-appointment";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { blocksForDoctor } from "@/lib/availability";
import type { CancelPreview } from "@/lib/cancel-preview";
import { requireRole } from "@/lib/session";
import { visitWhenLabel } from "@/lib/schedule";
import { clinicClock, clinicNow, slotArrived } from "@/lib/slots";
import { formatDate } from "@/lib/utils";
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

/** A clinic cancellation is never the patient's fault, so it always refunds in full. */
const CLINIC_CANCEL_PREVIEW: CancelPreview = {
  percentage: 100,
  headline: "Full refund if paid",
  detail: "A clinic cancellation is always refunded in full once the patient's payment is captured.",
};

type ScheduleRow = {
  readonly id: number;
  readonly date: string;
  readonly time: string;
  readonly status: AppointmentStatus;
  readonly reason: string | null;
  readonly patientName: string;
  readonly patientPhone: string | null;
  /** The window block this visit was booked into. */
  readonly availabilityId: number | null;
  /** Where this patient sits in the window's queue. */
  readonly seatNumber: number;
  readonly schedulingType: "wave" | "stream" | null;
  /** A stream window's end; null for a wave slot. */
  readonly windowEnd: string | null;
};

/**
 * How a visit reads for the doctor: a stream shows the window it belongs to
 * plus the patient's place in the queue, because every patient in that window
 * starts at the same moment. A wave shows its own start time.
 */
function doctorWhen(row: ScheduleRow, capacity: number | null) {
  const when = visitWhenLabel({
    schedulingType: row.schedulingType ?? "wave",
    time: row.time,
    windowEnd: row.windowEnd,
  });
  if (row.schedulingType === "stream" && capacity !== null) {
    return `${when} · #${row.seatNumber} of ${capacity}`;
  }
  return when;
}

function ScheduleItem({
  row,
  capacity,
  canResolve,
  canCancel,
}: {
  row: ScheduleRow;
  capacity: number | null;
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
              <Calendar className="h-3.5 w-3.5 text-ink-500" />
              {formatDate(row.date)} · {doctorWhen(row, capacity)}
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
          <CancelAppointment
            appointmentId={row.id}
            subject={`${row.patientName} · ${formatDate(row.date)} · ${doctorWhen(row, capacity)}`}
            preview={CLINIC_CANCEL_PREVIEW}
            clinicCancellation
            variant="outline"
          />
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
      availabilityId: appointments.availabilityId,
      seatNumber: appointments.seatNumber,
      schedulingType: availability.schedulingType,
      windowEnd: availability.endTime,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .leftJoin(availability, eq(appointments.availabilityId, availability.id))
    .where(
      and(
        eq(appointments.doctorId, session.profileId),
        eq(appointments.status, "booked"),
        gte(appointments.appointmentDate, now.date),
      ),
    )
    .orderBy(
      asc(appointments.appointmentDate),
      asc(appointments.appointmentTime),
      asc(appointments.seatNumber),
    )
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
      availabilityId: appointments.availabilityId,
      seatNumber: appointments.seatNumber,
      schedulingType: availability.schedulingType,
      windowEnd: availability.endTime,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .leftJoin(availability, eq(appointments.availabilityId, availability.id))
    .where(
      and(
        eq(appointments.doctorId, session.profileId),
        or(
          lt(appointments.appointmentDate, now.date),
          ne(appointments.status, "booked"),
        ),
      ),
    )
    .orderBy(
      desc(appointments.appointmentDate),
      desc(appointments.appointmentTime),
      desc(appointments.seatNumber),
    )
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

  const blocks = await blocksForDoctor(session.profileId);
  const windows: AvailabilityRow[] = [...blocks].sort((a, b) => {
    if (a.dayOfWeek !== b.dayOfWeek) {
      if (a.dayOfWeek === null) return 1;
      if (b.dayOfWeek === null) return -1;
      return a.dayOfWeek - b.dayOfWeek;
    }
    return a.startTime.localeCompare(b.startTime);
  }).map((block) => ({
    id: block.id,
    schedulingType: block.schedulingType,
    dayOfWeek: block.dayOfWeek,
    dates: block.dates,
    startTime: block.startTime,
    endTime: block.endTime,
    slotMinutes: block.slotMinutes,
    capacity: block.capacity,
  }));

  const capacityByBlock = new Map(blocks.map((block) => [block.id, block.capacity]));

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

  // Per-window booked counts for the availability editor: the floor an
  // elastic edit respects and the "N booked" a row shows next to its window.
  const bookedCounts: Record<number, number> = {};
  for (const row of bookedPerWindow) {
    if (row.availabilityId !== null) bookedCounts[row.availabilityId] = row.total;
  }

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
            { label: "Today", value: stats.today, tone: "text-teal-800", icon: <Calendar className="h-4 w-4" /> },
            { label: "Upcoming", value: stats.upcoming, tone: "text-ink-900", icon: <Clock className="h-4 w-4" /> },
            { label: "Patients seen", value: stats.patientsSeen, tone: "text-teal-800", icon: <Users className="h-4 w-4" /> },
            { label: "No-shows", value: stats.noShows, tone: "text-rose-700", icon: <AlertTriangle className="h-4 w-4" /> },
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
          <CardTitle>Availability</CardTitle>
          <p className="text-sm text-ink-500">
            Patients can only book inside these windows. Times are clinic time (IST).
          </p>
        </CardHeader>
        <CardContent>
          <AvailabilityManager
            windows={windows}
            lockedIds={lockedIds}
            bookedCounts={bookedCounts}
          />
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
                capacity={row.availabilityId === null ? null : (capacityByBlock.get(row.availabilityId) ?? null)}
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
                capacity={row.availabilityId === null ? null : (capacityByBlock.get(row.availabilityId) ?? null)}
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
