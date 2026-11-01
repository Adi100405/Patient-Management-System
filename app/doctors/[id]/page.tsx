import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { Briefcase, CalendarClock, CalendarDays, GraduationCap, Wallet } from "lucide-react";
import { getDb } from "@/db";
import { appointments, availability, doctors } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BookingPanel } from "@/components/booking-panel";
import { releaseExpiredPayments } from "@/lib/payments/expire";
import { getSession } from "@/lib/session";
import { availableSlots, buildSlots, upcomingDays } from "@/lib/slots";
import { formatCurrency, formatDate, formatTime } from "@/lib/utils";

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

  const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  // Everything the client picker needs, per day: its label and its free slots.
  // Built once here so switching days in the browser needs no server round
  // trip — the booking action is the only thing that ever hits the server.
  const bookingDays = dayOptions.map((day) => ({
    date: day.date,
    weekday: day.isToday ? "Today" : (WEEKDAYS[day.dayOfWeek]?.slice(0, 3) ?? ""),
    dayLabel: formatDate(day.date).replace(/^[A-Za-z]+,\s*/, ""),
    slots: day.times.map((time) => ({
      time,
      availabilityId:
        day.windows.find((w) => buildSlots(w).includes(time))?.id ?? day.windows[0]!.id,
    })),
  }));

  // Prefer the requested day, then the first day that still has a free slot, so
  // the picker never opens on an empty "no slots left" state.
  const initialDate =
    bookingDays.find((day) => day.date === dateParam)?.date ??
    bookingDays.find((day) => day.slots.length > 0)?.date ??
    bookingDays[0]?.date ??
    "";

  // The weekly schedule as a patient reads it: one tile per consulting day,
  // Monday first.
  const weeklySchedule = [...new Set(windows.map((w) => w.dayOfWeek))]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((day) => ({
      dayOfWeek: day,
      label: WEEKDAYS[day] ?? "",
      short: (WEEKDAYS[day] ?? "").slice(0, 3),
      ranges: windows
        .filter((w) => w.dayOfWeek === day)
        .map((w) => ({ id: w.id, start: w.startTime, end: w.endTime })),
    }));

  const slotLengths = [...new Set(windows.map((w) => w.slotMinutes))];

  const weeklyHours = Math.round(
    windows.reduce((total, w) => total + minutesBetween(w.startTime, w.endTime), 0) / 60,
  );

  const consultingDays =
    windows.length > 0
      ? [...new Set(windows.map((w) => w.dayOfWeek))]
          .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
          .map((day) => WEEKDAYS[day]?.slice(0, 3) ?? "")
          .join(", ")
      : "Not set";

  return (
    <div className="space-y-6">
      <Link href="/doctors" className="text-sm font-medium text-teal-700 hover:underline">
        ← Back to doctors
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card className="min-w-0">
          <CardHeader>
            <div className="flex items-start gap-4">
              <span
                aria-hidden="true"
                className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-teal-50 text-lg font-semibold text-teal-800 ring-1 ring-inset ring-teal-100"
              >
                {initials(doctor.fullName)}
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-xl">{doctor.fullName}</CardTitle>
                  <Badge variant="booked">Verified</Badge>
                </div>
                <p className="text-sm font-medium text-teal-700">{doctor.specialization}</p>
                <p className="text-sm leading-relaxed text-ink-600">
                  {doctor.bio ??
                    `${doctor.fullName} is a ${doctor.specialization.toLowerCase()} specialist with ${doctor.experienceYears} years of clinical experience.`}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <dl className="grid grid-cols-2 gap-3">
              {[
                { label: "Experience", value: `${doctor.experienceYears} years`, Icon: Briefcase },
                { label: "Qualification", value: doctor.qualification ?? "MBBS", Icon: GraduationCap },
                { label: "Consultation fee", value: formatCurrency(doctor.consultationFee), Icon: Wallet },
                { label: "Consulting days", value: consultingDays, Icon: CalendarDays },
              ].map((fact) => (
                <div
                  key={fact.label}
                  className="rounded-xl border border-cream-200 bg-cream-50/60 p-3.5"
                >
                  <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
                    <fact.Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {fact.label}
                  </dt>
                  <dd className="mt-1.5 text-sm font-semibold text-ink-900">{fact.value}</dd>
                </div>
              ))}
            </dl>

            {windows.length > 0 && (
              <div className="overflow-hidden rounded-2xl border border-cream-200 shadow-sm">
                <div className="bg-gradient-to-br from-teal-800 to-teal-950 px-4 py-4 text-white">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal-100">
                    <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                    Weekly availability
                  </p>
                  <dl className="mt-3.5 grid grid-cols-3 divide-x divide-white/10 text-center">
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-teal-200/80">
                        Days a week
                      </dt>
                      <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                        {weeklySchedule.length}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-teal-200/80">
                        Clinic hours
                      </dt>
                      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{weeklyHours}h</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-teal-200/80">
                        Slot length
                      </dt>
                      <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                        {slotLengths.length === 1 ? `${slotLengths[0]}m` : "Mixed"}
                      </dd>
                    </div>
                  </dl>
                </div>
                <ul className="divide-y divide-cream-200 bg-white">
                  {weeklySchedule.map((day) => (
                    <li
                      key={day.dayOfWeek}
                      className="flex items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-teal-50 text-[10px] font-bold uppercase tracking-wide text-teal-800 ring-1 ring-inset ring-teal-100"
                        >
                          {day.short}
                        </span>
                        <span className="truncate text-sm font-medium text-ink-900">
                          {day.label}
                        </span>
                      </span>
                      <span className="flex flex-wrap justify-end gap-1.5">
                        {day.ranges.map((range) => (
                          <span
                            key={range.id}
                            className="rounded-lg bg-cream-50 px-2 py-1 text-xs font-medium tabular-nums text-ink-700 ring-1 ring-inset ring-cream-200"
                          >
                            {formatTime(range.start)} – {formatTime(range.end)}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="gap-2">
            <div className="flex items-start justify-between gap-3">
              <CardTitle>Book an appointment</CardTitle>
              <span className="shrink-0 rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium tabular-nums text-ink-700 ring-1 ring-inset ring-cream-200">
                {formatCurrency(doctor.consultationFee)}
                {slotLengths.length === 1 ? ` · ${slotLengths[0]} min` : ""}
              </span>
            </div>
            <p className="text-sm text-ink-500">Pick a day, then choose a free slot.</p>
          </CardHeader>
          <CardContent className="space-y-5">
            {dayOptions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-5 text-center">
                <p className="text-sm font-medium text-ink-800">No availability published yet</p>
                <p className="mt-1 text-sm text-ink-500">
                  This doctor has not opened their calendar. Please check back soon.
                </p>
              </div>
            ) : session?.role === "doctor" ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-800">
                You are signed in as a doctor. Use a patient account to book.
              </p>
            ) : (
              <BookingPanel
                doctorId={doctor.id}
                days={bookingDays}
                initialDate={initialDate}
                isSignedIn={Boolean(session)}
              />
            )}

            {dayOptions.length > 0 && (
              <p className="border-t border-cream-200 pt-4 text-xs leading-relaxed text-ink-500">
                Cancel free up to 24 hours before your visit. Within 24 hours, 50% is
                refunded; within 2 hours, the fee is not refundable.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {!session && (
        <p className="text-sm text-ink-600">
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

/** "Nisha Rao" -> "NR" — the same monogram the dashboards use. */
function initials(fullName: string) {
  return fullName
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** "10:00", "14:30" -> minutes, used for the weekly-hours summary. */
function minutesBetween(start: string, end: string) {
  const toMinutes = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return toMinutes(end) - toMinutes(start);
}
