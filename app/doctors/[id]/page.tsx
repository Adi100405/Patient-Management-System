import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, availability, doctors } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SlotPicker } from "@/components/slot-picker";
import { releaseExpiredPayments } from "@/lib/payments/expire";
import { getSession } from "@/lib/session";
import { availableSlots, buildSlots, upcomingDays } from "@/lib/slots";
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

  // Free any slot whose unpaid checkout has expired before we compute what is
  // bookable. Best-effort: a sweep failure must not take the page down.
  await releaseExpiredPayments().catch(() => 0);

  const [doctor] = await db.select().from(doctors).where(eq(doctors.id, doctorId)).limit(1);
  if (!doctor) notFound();

  const windows = await db
    .select()
    .from(availability)
    .where(and(eq(availability.doctorId, doctorId), eq(availability.isActive, true)))
    .orderBy(asc(availability.dayOfWeek), asc(availability.startTime));

  const days = upcomingDays(7);
  const workingDays = days.filter((d) => windows.some((w) => w.dayOfWeek === d.dayOfWeek));

  const session = await getSession();

  const bookedRows = workingDays.length
    ? await db
        .select({ date: appointments.appointmentDate, time: appointments.appointmentTime })
        .from(appointments)
        .where(
          and(
            eq(appointments.doctorId, doctorId),
            eq(appointments.status, "booked"),
            gte(appointments.appointmentDate, days[0]!.date),
            lte(appointments.appointmentDate, days[days.length - 1]!.date),
          ),
        )
    : [];

  const bookedByDate = new Map<string, string[]>();
  for (const row of bookedRows) {
    bookedByDate.set(row.date, [...(bookedByDate.get(row.date) ?? []), row.time]);
  }

  /** Working days with the slots a patient can actually pick right now. */
  const dayOptions = workingDays.map((day) => {
    const dayWindows = windows.filter((w) => w.dayOfWeek === day.dayOfWeek);
    const times = availableSlots({
      windows: dayWindows,
      date: day.date,
      bookedTimes: bookedByDate.get(day.date) ?? [],
    });
    return {
      ...day,
      times,
      windows: dayWindows,
    };
  });

  // Prefer the requested day, then the first day that still has a free slot, so
  // the picker never opens on an empty "no slots left" state.
  const activeDay =
    dayOptions.find((day) => day.date === dateParam) ??
    dayOptions.find((day) => day.times.length > 0) ??
    dayOptions[0];

  const slots: { time: string; availabilityId: number }[] = activeDay
    ? activeDay.times.map((time) => ({
        time,
        availabilityId:
          activeDay.windows.find((w) => buildSlots(w).includes(time))?.id ??
          activeDay.windows[0]!.id,
      }))
    : [];

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
            {dayOptions.length === 0 ? (
              <p className="text-sm text-slate-600">
                This doctor has not published availability yet. Please check back later.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {dayOptions.map((day) => (
                    <Link
                      key={day.date}
                      href={`/doctors/${doctor.id}?date=${day.date}`}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-xs font-medium",
                        day.date === activeDay?.date
                          ? "border-teal-600 bg-teal-600 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                      )}
                    >
                      {day.isToday ? "Today" : formatDate(day.date)}
                      {day.times.length === 0 && (
                        <span className="ml-1 text-[10px] opacity-70">(full)</span>
                      )}
                    </Link>
                  ))}
                </div>

                {session?.role === "doctor" ? (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                    You are signed in as a doctor. Sign in with a patient account to book.
                  </p>
                ) : activeDay ? (
                  <SlotPicker
                    doctorId={doctor.id}
                    date={activeDay.date}
                    slots={slots}
                    isSignedIn={Boolean(session)}
                  />
                ) : null}
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
