import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, availability, doctors } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SlotPicker } from "@/components/slot-picker";
import { getSession } from "@/lib/session";
import { availableSlots, buildSlots, dayOfWeekFor, upcomingDays } from "@/lib/slots";
import { cn, formatCurrency, formatDate, formatTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DoctorProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  const { date: dateParam } = await searchParams;
  const doctorId = Number(id);
  if (!Number.isInteger(doctorId)) notFound();

  const db = getDb();
  const [doctor] = await db.select().from(doctors).where(eq(doctors.id, doctorId)).limit(1);
  if (!doctor) notFound();

  const windows = await db
    .select()
    .from(availability)
    .where(and(eq(availability.doctorId, doctorId), eq(availability.isActive, true)))
    .orderBy(asc(availability.dayOfWeek), asc(availability.startTime));

  const days = upcomingDays(7);
  const workingDays = days.filter((d) => windows.some((w) => w.dayOfWeek === d.dayOfWeek));
  const activeDate = dateParam && days.some((d) => d.date === dateParam) ? dateParam : workingDays[0]?.date;

  const session = await getSession();

  let slots: { time: string; availabilityId: number }[] = [];
  if (activeDate) {
    const booked = await db
      .select({ time: appointments.appointmentTime })
      .from(appointments)
      .where(
        and(
          eq(appointments.doctorId, doctorId),
          eq(appointments.appointmentDate, activeDate),
          eq(appointments.status, "booked"),
        ),
      );

    const dayWindows = windows.filter((w) => w.dayOfWeek === dayOfWeekFor(activeDate));
    const open = availableSlots({
      windows: dayWindows,
      date: activeDate,
      bookedTimes: booked.map((b) => b.time),
    });
    slots = open.map((time) => ({
      time,
      availabilityId:
        dayWindows.find((w) => buildSlots(w).includes(time))?.id ?? dayWindows[0]!.id,
    }));
  }

  return (
    <div className="space-y-6">
      <Link href="/doctors" className="text-sm font-medium text-teal-700 hover:underline">
        ← Back to doctors
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-xl">{doctor.fullName}</CardTitle>
                <p className="text-sm font-medium text-teal-700">{doctor.specialization}</p>
              </div>
              <Badge variant="booked">Verified doctor</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 text-sm text-slate-600">
            <p>
              {doctor.bio ??
                `${doctor.fullName} is a ${doctor.specialization.toLowerCase()} specialist with ${doctor.experienceYears} years of clinical experience.`}
            </p>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Experience</dt>
                <dd className="font-medium text-slate-900">{doctor.experienceYears} years</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Qualification</dt>
                <dd className="font-medium text-slate-900">{doctor.qualification ?? "MBBS"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Consultation fee</dt>
                <dd className="font-medium text-slate-900">{formatCurrency(doctor.consultationFee)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Consulting days</dt>
                <dd className="font-medium text-slate-900">
                  {windows.length > 0
                    ? [...new Set(windows.map((w) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][w.dayOfWeek]))].join(", ")
                    : "Not set"}
                </dd>
              </div>
            </dl>

            {windows.length > 0 && (
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Weekly availability</p>
                <ul className="mt-2 space-y-1">
                  {windows.map((w) => (
                    <li key={w.id} className="text-sm text-slate-700">
                      {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][w.dayOfWeek]} ·{" "}
                      {formatTime(w.startTime)} – {formatTime(w.endTime)}{" "}
                      <span className="text-slate-500">({w.slotMinutes} min slots)</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Book an appointment</CardTitle>
            <p className="text-sm text-slate-500">Choose a day, then pick a free slot.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            {workingDays.length === 0 ? (
              <p className="text-sm text-slate-600">
                This doctor has not published availability yet. Please check back later.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {workingDays.map((day) => (
                    <Link
                      key={day.date}
                      href={`/doctors/${doctor.id}?date=${day.date}`}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-xs font-medium",
                        day.date === activeDate
                          ? "border-teal-600 bg-teal-600 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                      )}
                    >
                      {day.isToday ? "Today" : formatDate(day.date)}
                    </Link>
                  ))}
                </div>

                {session?.role === "doctor" ? (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                    You are signed in as a doctor. Sign in with a patient account to book.
                  </p>
                ) : (
                  <SlotPicker
                    doctorId={doctor.id}
                    date={activeDate!}
                    slots={slots}
                    isSignedIn={Boolean(session)}
                  />
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {!session && (
        <p className="text-sm text-slate-600">
          New here?{" "}
          <Link href="/sign-up" className="font-medium text-teal-700 hover:underline">
            Create a patient account
          </Link>{" "}
          to confirm your booking.
        </p>
      )}
    </div>
  );
}
