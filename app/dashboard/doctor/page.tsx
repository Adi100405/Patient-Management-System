import { and, asc, eq, gte, sql } from "drizzle-orm";
import { cancelAppointment } from "@/actions/booking";
import { getDb } from "@/db";
import { appointments, availability, patients } from "@/db/schema";
import { AvailabilityManager } from "@/components/availability-manager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/session";
import { clinicNow } from "@/lib/slots";
import { formatDate, formatTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Doctor dashboard — Medrella" };

const statusVariant = {
  booked: "booked",
  cancelled: "cancelled",
  completed: "completed",
} as const;

export default async function DoctorDashboard() {
  const session = await requireRole("doctor");
  const db = getDb();

  const rows = await db
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
    .where(eq(appointments.doctorId, session.profileId))
    .orderBy(asc(appointments.appointmentDate), asc(appointments.appointmentTime));

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
        gte(appointments.appointmentDate, clinicNow().date),
      ),
    )
    .groupBy(appointments.availabilityId);

  const lockedIds = bookedPerWindow
    .filter((row) => row.availabilityId !== null && row.total > 0)
    .map((row) => row.availabilityId as number);

  const today = clinicNow().date;
  const todays = rows.filter((r) => r.date === today && r.status === "booked");
  const upcoming = rows.filter((r) => r.status === "booked" && r.date >= today);
  const uniquePatients = new Set(rows.map((r) => r.patientName)).size;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dr. {session.name}</h1>
        <p className="text-sm text-slate-600">
          Appointments booked by patients appear here in real time.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Today", value: todays.length },
          { label: "Upcoming", value: upcoming.length },
          { label: "Patients seen", value: uniquePatients },
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
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 ? (
            <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-600">
              No appointments yet. Patients who book with you will show up here instantly.
            </p>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <p className="font-medium text-slate-900">{row.patientName}</p>
                  <p className="text-sm text-slate-600">
                    {formatDate(row.date)} at {formatTime(row.time)}
                    {row.patientPhone ? ` · ${row.patientPhone}` : ""}
                  </p>
                  {row.reason && <p className="text-xs text-slate-500">Reason: {row.reason}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={statusVariant[row.status]}>{row.status}</Badge>
                  {row.status === "booked" && (
                    <form action={cancelAppointment}>
                      <input type="hidden" name="appointmentId" value={row.id} />
                      <Button variant="outline" size="sm" type="submit">
                        Cancel
                      </Button>
                    </form>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
