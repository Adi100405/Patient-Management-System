import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { Briefcase, CalendarClock, CalendarDays, GraduationCap, Wallet } from "lucide-react";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BookingPanel } from "@/components/booking-panel";
import { blocksForDoctor } from "@/lib/availability";
import { releaseExpiredPayments } from "@/lib/payments/expire";
import { takenSeatsByTime } from "@/lib/seats";
import { getSession } from "@/lib/session";
import { dayOption, clinicNow, upcomingDays, type DayOption } from "@/lib/slots";
import { offersFor, openDates, type DatedBlock, type WeeklyBlock } from "@/lib/schedule";
import { formatCurrency, formatDate, formatTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** How far ahead a dated block may reach and still show up in the day picker. */
const DATED_HORIZON_DAYS = 60;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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

  const session = await getSession();

  const blocks = await blocksForDoctor(doctorId);
  const now = clinicNow();
  const days = upcomingDays(7);
  const horizon = upcomingDays(DATED_HORIZON_DAYS);
  const horizonEnd = horizon[horizon.length - 1]?.date ?? now.date;

  // The dates a patient may book: the next seven days, plus any specific date
  // the doctor opened further out.
  const candidates = new Map<string, DayOption>();
  for (const day of days) candidates.set(day.date, day);
  for (const block of blocks) {
    for (const date of block.dates) {
      if (date < now.date || date > horizonEnd) continue;
      if (!candidates.has(date)) candidates.set(date, dayOption(date));
    }
  }

  const orderedDays = openDates(
    blocks,
    [...candidates.values()].sort((a, b) => a.date.localeCompare(b.date)),
  );

  const taken = orderedDays.length
    ? await takenSeatsByTime({
        doctorId,
        dateFrom: orderedDays[0]!.date,
        dateTo: orderedDays[orderedDays.length - 1]!.date,
      })
    : new Map<string, Map<string, number>>();

  /** Working days with the slots a patient can actually pick right now. */
  const dayOptions = orderedDays.map((day) => ({
    ...day,
    offers: offersFor({
      blocks,
      date: day.date,
      takenSeats: taken.get(day.date) ?? new Map<string, number>(),
      now,
    }),
  }));

  // Everything the client picker needs, per day: its label and its free slots.
  // Built once here so switching days in the browser needs no server round
  // trip — the booking action is the only thing that ever hits the server.
  const bookingDays = dayOptions.map((day) => ({
    date: day.date,
    weekday: day.isToday ? "Today" : (WEEKDAYS[day.dayOfWeek]?.slice(0, 3) ?? ""),
    dayLabel: formatDate(day.date).replace(/^[A-Za-z]+,\s*/, ""),
    freeSeats: day.offers.reduce((sum, offer) => sum + offer.free, 0),
    slots: day.offers
      .filter((offer) => offer.free > 0)
      .map((offer) => ({
        time: offer.time,
        availabilityId: offer.availabilityId,
        schedulingType: offer.schedulingType,
        seats: offer.seats,
        free: offer.free,
      })),
  }));

  // Prefer the requested day, then the first day that still has a free slot, so
  // the picker never opens on an empty "no slots left" state.
  const initialDate =
    bookingDays.find((day) => day.date === dateParam)?.date ??
    bookingDays.find((day) => day.freeSeats > 0)?.date ??
    bookingDays[0]?.date ??
    "";

  const weeklyBlocks = blocks.filter(
    (block): block is WeeklyBlock => block.dayOfWeek !== null,
  );
  const datedBlocks = blocks.filter(
    (block): block is DatedBlock => block.dayOfWeek === null,
  );

  // The weekly schedule as a patient reads it: one tile per consulting day,
  // Monday first.
  const weeklySchedule = [...new Set(weeklyBlocks.map((block) => block.dayOfWeek))]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((day) => ({
      dayOfWeek: day,
      label: WEEKDAYS[day] ?? "",
      short: (WEEKDAYS[day] ?? "").slice(0, 3),
      ranges: weeklyBlocks
        .filter((block) => block.dayOfWeek === day)
        .map((block) => ({
          id: block.id,
          start: block.startTime,
          end: block.endTime,
          style: describeStyle(block),
        })),
    }));

  const styles = [...new Set(blocks.map((block) => block.schedulingType))];

  const weeklyHours = Math.round(
    (weeklyBlocks.length ? weeklyBlocks : blocks).reduce(
      (total, block) => total + minutesBetween(block.startTime, block.endTime),
      0,
    ) / 60,
  );

  const consultingDays =
    weeklyBlocks.length > 0
      ? [...new Set(weeklyBlocks.map((block) => block.dayOfWeek))]
          .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
          .map((day) => WEEKDAYS[day]?.slice(0, 3) ?? "")
          .join(", ")
      : datedBlocks.length > 0
        ? "By date"
        : "Not set";

  const visitLengths = [...new Set(blocks.map((block) => block.slotMinutes))];

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

            {blocks.length > 0 && (
              <div className="overflow-hidden rounded-2xl border border-cream-200 shadow-sm">
                <div className="bg-gradient-to-br from-teal-800 to-teal-950 px-4 py-4 text-white">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal-100">
                    <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                    Availability
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
                        Scheduling
                      </dt>
                      <dd className="mt-0.5 text-sm font-semibold">
                        {styles.map((style) => (style === "wave" ? "Wave" : "Stream")).join(" · ")}
                      </dd>
                    </div>
                  </dl>
                </div>

                {weeklySchedule.length > 0 && (
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
                              <span className="ml-1.5 font-normal text-ink-500">
                                {range.style}
                              </span>
                            </span>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {datedBlocks.length > 0 && (
                  <div className="border-t border-cream-200 bg-white px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                      Specific dates
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {datedBlocks.map((block) => (
                        <li
                          key={block.id}
                          className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
                        >
                          <span className="text-ink-800">
                            {block.dates.map((date) => formatDate(date)).join(", ")}
                          </span>
                          <span className="text-xs tabular-nums text-ink-500">
                            {formatTime(block.startTime)} – {formatTime(block.endTime)} ·{" "}
                            {describeStyle(block)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
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
                {visitLengths.length === 1 ? ` · ${visitLengths[0]} min` : ""}
              </span>
            </div>
            <p className="text-sm text-ink-500">
              Pick a day, then choose a free slot. A wave slot holds several patients.
            </p>
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

/** How a block is styled and how many patients it holds. */
function describeStyle(block: {
  readonly schedulingType: string;
  readonly capacity: number;
  readonly slotMinutes: number;
}) {
  return block.schedulingType === "wave"
    ? `Wave · ${block.capacity} per slot · ${block.slotMinutes} min`
    : `Stream · ${block.capacity} in window`;
}

/** "10:00", "14:30" -> minutes, used for the weekly-hours summary. */
function minutesBetween(start: string, end: string) {
  const toMinutes = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return toMinutes(end) - toMinutes(start);
}
