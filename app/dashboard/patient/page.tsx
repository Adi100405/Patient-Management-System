import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { cancelAppointment } from "@/actions/booking";
import { getDb } from "@/db";
import { appointments, doctors } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/session";
import { formatDate, formatTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Patient dashboard — Medrella" };

const statusVariant = {
  booked: "booked",
  cancelled: "cancelled",
  completed: "completed",
} as const;

export default async function PatientDashboard() {
  const session = await requireRole("patient");
  const db = getDb();

  const rows = await db
    .select({
      id: appointments.id,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      status: appointments.status,
      reason: appointments.reason,
      doctorName: doctors.fullName,
      specialization: doctors.specialization,
      fee: doctors.consultationFee,
    })
    .from(appointments)
    .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
    .where(eq(appointments.patientId, session.profileId))
    .orderBy(asc(appointments.appointmentDate), asc(appointments.appointmentTime));

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter((r) => r.status === "booked" && r.date >= today);
  const history = rows.filter((r) => !upcoming.includes(r)).reverse();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My appointments</h1>
        <p className="text-sm text-slate-600">
          Welcome back, {session.name}. Here is everything you have booked.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Upcoming", value: upcoming.length },
          { label: "Total bookings", value: rows.length },
          {
            label: "Cancelled",
            value: rows.filter((r) => r.status === "cancelled").length,
          },
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
          <CardTitle>Upcoming</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {upcoming.length === 0 ? (
            <div className="rounded-lg bg-slate-50 p-5 text-sm text-slate-600">
              No upcoming appointments.{" "}
              <Link href="/doctors" className="font-medium text-teal-700 hover:underline">
                Find a doctor
              </Link>{" "}
              to book one.
            </div>
          ) : (
            upcoming.map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <p className="font-medium text-slate-900">
                    Dr. {row.doctorName}{" "}
                    <span className="text-sm font-normal text-teal-700">· {row.specialization}</span>
                  </p>
                  <p className="text-sm text-slate-600">
                    {formatDate(row.date)} at {formatTime(row.time)}
                  </p>
                  {row.reason && <p className="text-xs text-slate-500">Reason: {row.reason}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={statusVariant[row.status]}>{row.status}</Badge>
                  <form action={cancelAppointment}>
                    <input type="hidden" name="appointmentId" value={row.id} />
                    <Button variant="outline" size="sm" type="submit">
                      Cancel
                    </Button>
                  </form>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {history.length === 0 ? (
            <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-600">
              Nothing here yet — past and cancelled appointments will appear here.
            </p>
          ) : (
            history.map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-slate-800">
                    Dr. {row.doctorName}{" "}
                    <span className="font-normal text-slate-500">· {row.specialization}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatDate(row.date)} at {formatTime(row.time)}
                  </p>
                </div>
                <Badge variant={statusVariant[row.status]}>{row.status}</Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
