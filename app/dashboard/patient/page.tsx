import Link from "next/link";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { cancelAppointment } from "@/actions/booking";
import { getDb } from "@/db";
import { appointments, availability, doctors, patients, payments, users } from "@/db/schema";
import type { AppointmentStatus } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentCheckout } from "@/components/payment-checkout";
import { NotificationPreferences } from "@/components/notification-preferences";
import { RefundStatusLine } from "@/components/refund-status";
import { RescheduleAppointment, type RescheduleDayOption } from "@/components/reschedule-appointment";
import { refundsForPatient } from "@/lib/refunds/queries";
import { preferencesForUser } from "@/lib/notifications/preferences";
import { sweepReminders } from "@/lib/notifications/reminders";
import { requireRole } from "@/lib/session";
import { availableSlots, clinicNow, upcomingDays } from "@/lib/slots";
import { formatDate, formatTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Patient dashboard — Medrella" };

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

export default async function PatientDashboard() {
  const session = await requireRole("patient");

  // Reminders are derived from live state, so this sweep is both the scheduled
  // behaviour and its own safety net: opening the dashboard sends whatever has
  // come due. Best-effort — a sweep failure must not take the page down.
  await sweepReminders().catch(() => null);
  const db = getDb();

  const rows = await db
    .select({
      id: appointments.id,
      doctorId: appointments.doctorId,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      status: appointments.status,
      reason: appointments.reason,
      doctorName: doctors.fullName,
      specialization: doctors.specialization,
      fee: doctors.consultationFee,
      paymentStatus: payments.status,
      paymentId: payments.id,
      paymentAmount: payments.amount,
      paymentCurrency: payments.currency,
      paymentProvider: payments.provider,
      paymentFailure: payments.failureReason,
    })
    .from(appointments)
    .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
    .leftJoin(payments, eq(payments.appointmentId, appointments.id))
    .where(eq(appointments.patientId, session.profileId))
    .orderBy(asc(appointments.appointmentDate), asc(appointments.appointmentTime));

  const refundsByPayment = await refundsForPatient(session.profileId);

  // Contact details + channel choices for the preferences card. A missing
  // profile row cannot happen for a signed-in session, but the card would
  // render with defaults rather than take the page down.
  const [profile] = await db
    .select({ userId: users.id, phone: patients.phone })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(patients.id, session.profileId))
    .limit(1);
  const preferences = profile
    ? await preferencesForUser(profile.userId)
    : await Promise.resolve(null);

  const today = clinicNow().date;
  const upcoming = rows.filter((r) => r.status === "booked" && r.date >= today);
  const history = rows.filter((r) => !upcoming.includes(r)).reverse();

  // Free-slot options for rescheduling, computed once per doctor (not per
  // row) with the same availability logic the booking page uses. The patient's
  // own current slot is excluded from the booked set, so a day tab can show it
  // again if it is otherwise free.
  const rescheduleDays = new Map<number, RescheduleDayOption[]>();
  const doctorIds = [...new Set(upcoming.map((r) => r.doctorId))];
  const days7 = upcomingDays(7);
  if (doctorIds.length > 0) {
    const windows = await db
      .select()
      .from(availability)
      .where(and(inArray(availability.doctorId, doctorIds), eq(availability.isActive, true)));
    const horizonStart = days7[0]!.date;
    const horizonEnd = days7[days7.length - 1]!.date;
    const allBooked = await db
      .select({
        doctorId: appointments.doctorId,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
      })
      .from(appointments)
      .where(
        and(
          inArray(appointments.doctorId, doctorIds),
          eq(appointments.status, "booked"),
          gte(appointments.appointmentDate, horizonStart),
          lte(appointments.appointmentDate, horizonEnd),
        ),
      );

    for (const row of upcoming) {
      const doctorWindows = windows.filter((w) => w.doctorId === row.doctorId);
      rescheduleDays.set(
        row.id,
        days7.map((day) => ({
          date: day.date,
          label: day.label,
          isToday: day.isToday,
          times: availableSlots({
            windows: doctorWindows.filter((w) => w.dayOfWeek === day.dayOfWeek),
            date: day.date,
            bookedTimes: allBooked
              .filter(
                (b) =>
                  b.doctorId === row.doctorId &&
                  b.date === day.date &&
                  // The appointment being rescheduled is not its own competitor.
                  !(b.date === row.date && b.time === row.time),
              )
              .map((b) => b.time),
          }),
        })),
      );
    }
  }

  const awaitingPayment = upcoming.filter(
    (r) => r.paymentStatus === "pending" && r.paymentProvider !== "manual",
  ).length;
  const paidTotal = rows
    .filter((r) => r.paymentStatus === "succeeded" || r.paymentStatus === "partially_refunded")
    .reduce((sum, r) => sum + Number(r.paymentAmount ?? 0), 0);
  const refundsInProgress = [...refundsByPayment.values()]
    .flat()
    .filter((refund) => refund.status === "pending" || refund.status === "processing").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">My appointments</h1>
        <p className="text-sm text-ink-500">
          Welcome back, {session.name.split(" ")[0]}. Every visit, payment and refund in one place.
        </p>
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 divide-cream-200 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
          {[
            { label: "Upcoming", value: upcoming.length, tone: "text-teal-800", icon: <CalendarIcon /> },
            { label: "Awaiting payment", value: awaitingPayment, tone: "text-amber-700", icon: <ClockIcon /> },
            { label: "Total bookings", value: rows.length, tone: "text-ink-900", icon: <BookmarkIcon /> },
            { label: "Paid to date", value: `₹${paidTotal.toFixed(0)}`, tone: "text-teal-800", icon: <ReceiptIcon /> },
            { label: "Refunds in progress", value: refundsInProgress, tone: "text-rose-700", icon: <RefreshIcon /> },
          ].map((stat) => (
            <div key={stat.label} className="flex items-center gap-3 p-4 last:col-span-2 last:sm:col-span-1 sm:p-5">
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
          <CardTitle>Upcoming</CardTitle>
          <p className="text-sm text-ink-500">Your next visits. Move or cancel any of them from here.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {upcoming.length === 0 ? (
            <div className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-6 text-center">
              <p className="text-sm font-medium text-ink-800">No upcoming appointments</p>
              <p className="mt-1 text-sm text-ink-500">Find a doctor and book your first visit in under a minute.</p>
              <Link href="/doctors" className="mt-3 inline-block">
                <Button size="sm">Find a doctor</Button>
              </Link>
            </div>
          ) : (
            upcoming.map((row) => (
              <div
                key={row.id}
                className="space-y-3 rounded-2xl border border-cream-200 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-teal-50 text-sm font-semibold text-teal-800 ring-1 ring-inset ring-teal-100"
                    >
                      {initials(row.doctorName)}
                    </span>
                    <div className="min-w-0 space-y-1.5">
                      <p className="font-semibold text-ink-900">
                        Dr. {row.doctorName}{" "}
                        <span className="text-sm font-normal text-teal-700">· {row.specialization}</span>
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium text-ink-700">
                          <CalendarIcon className="h-3.5 w-3.5 text-ink-500" />
                          {formatDate(row.date)} · {formatTime(row.time)}
                        </span>
                        <PaymentChip row={row} />
                      </div>
                      {row.reason && (
                        <p className="text-xs text-ink-500">
                          Reason: <span className="text-ink-700">{row.reason}</span>
                        </p>
                      )}
                    </div>
                  </div>
                  <Badge variant={statusVariant[row.status]} className="shrink-0">
                    {statusLabel[row.status]}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-cream-100 pt-3">
                  {row.paymentStatus === "pending" && row.paymentProvider !== "manual" && (
                    <PaymentCheckout
                      appointmentId={row.id}
                      amount={String(row.paymentAmount ?? row.fee)}
                      currency={row.paymentCurrency ?? "INR"}
                    />
                  )}
                  {row.paymentStatus === "succeeded" && row.paymentId !== null && (
                    <Link
                      href={`/dashboard/patient/receipts/${row.paymentId}`}
                      className="rounded-xl px-3 py-1.5 text-sm font-medium text-teal-700 transition-colors hover:bg-teal-50"
                    >
                      Receipt
                    </Link>
                  )}
                  <form action={cancelAppointment}>
                    <input type="hidden" name="appointmentId" value={row.id} />
                    <Button variant="ghost" size="sm" type="submit">
                      Cancel
                    </Button>
                  </form>
                  {(rescheduleDays.get(row.id) ?? []).some(
                    (d) => d.times.some((time) => !(d.date === row.date && time === row.time)),
                  ) && (
                    <RescheduleAppointment
                      appointmentId={row.id}
                      currentLabel={`${formatDate(row.date)} at ${formatTime(row.time)}`}
                      currentDate={row.date}
                      currentTime={row.time}
                      days={rescheduleDays.get(row.id)!}
                    />
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <p className="text-sm text-ink-500">Past and cancelled visits, with their payment trail.</p>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {history.length === 0 ? (
            <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-5 text-sm text-ink-500">
              Nothing here yet — past and cancelled appointments will appear here.
            </p>
          ) : (
            history.map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-2 rounded-xl border border-cream-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-ink-800">
                    Dr. {row.doctorName}{" "}
                    <span className="font-normal text-ink-500">· {row.specialization}</span>
                  </p>
                  <p className="text-xs text-ink-500">
                    {formatDate(row.date)} at {formatTime(row.time)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2.5">
                  {row.paymentStatus === "succeeded" && (
                    <span className="text-xs font-medium text-teal-700">
                      Paid ₹{Number(row.paymentAmount).toFixed(0)}
                    </span>
                  )}
                  {row.paymentStatus === "partially_refunded" && (
                    <span className="text-xs text-ink-600">Partly refunded</span>
                  )}
                  {row.paymentStatus === "refunded" && (
                    <span className="text-xs text-ink-600">Refund issued</span>
                  )}
                  {row.paymentStatus === "failed" && row.paymentFailure && (
                    <span className="text-xs text-rose-600">
                      {row.paymentFailure === "checkout_expired"
                        ? "Payment expired"
                        : row.paymentFailure === "cancelled_by_patient"
                          ? "Cancelled before payment"
                          : "Payment failed"}
                    </span>
                  )}
                  <RefundStatusLine refunds={refundsByPayment.get(row.paymentId ?? -1) ?? []} />
                  {(row.paymentStatus === "succeeded" ||
                    row.paymentStatus === "partially_refunded" ||
                    row.paymentStatus === "refunded") &&
                    row.paymentId !== null && (
                      <Link
                        href={`/dashboard/patient/receipts/${row.paymentId}`}
                        className="text-xs font-medium text-teal-700 hover:underline"
                      >
                        Receipt
                      </Link>
                    )}
                  <Badge variant={statusVariant[row.status]}>{statusLabel[row.status]}</Badge>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {profile && preferences && (
        <NotificationPreferences
          initial={{
            emailEnabled: preferences.emailEnabled,
            smsEnabled: preferences.smsEnabled,
            smsConsented: preferences.smsConsentAt !== null,
            marketingOptIn: preferences.marketingOptIn,
            phone: profile.phone ?? "",
          }}
        />
      )}
    </div>
  );
}

/** "Aarav Mehta" -> "AM" — a small human touch beside the doctor's name. */
function initials(fullName: string) {
  return fullName
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Payment state as a chip, so money is never a grey afterthought. */
function PaymentChip({
  row,
}: {
  row: {
    paymentStatus: string | null;
    paymentProvider: string | null;
    paymentAmount: string | null;
    fee: string;
    paymentCurrency: string | null;
  };
}) {
  const amount = Number(row.paymentAmount ?? row.fee).toFixed(0);
  const currency = row.paymentCurrency ?? "INR";

  if (row.paymentStatus === "succeeded") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-800 ring-1 ring-inset ring-teal-200">
        <CheckIcon className="h-3.5 w-3.5" />
        Paid ₹{amount} {currency}
      </span>
    );
  }
  if (row.paymentStatus === "pending" && row.paymentProvider !== "manual") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
        <ClockIcon className="h-3.5 w-3.5" />
        Payment pending
      </span>
    );
  }
  if (row.paymentStatus === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
        Payment failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium text-ink-600 ring-1 ring-inset ring-cream-200">
      ₹{amount} payable at the clinic
    </span>
  );
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

function BookmarkIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M4 4.75A1.75 1.75 0 0 1 5.75 3h8.5A1.75 1.75 0 0 1 16 4.75v11.5a.75.75 0 0 1-1.16.63L10 13.66l-4.84 3.22A.75.75 0 0 1 4 16.25V4.75Z" />
    </svg>
  );
}

function ReceiptIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path
        fillRule="evenodd"
        d="M4 3.75A1.75 1.75 0 0 1 5.75 2h8.5A1.75 1.75 0 0 1 16 3.75v13.5a.75.75 0 0 1-1.16.63L12 16.16l-2.84 1.72a.75.75 0 0 1-.76 0L5.56 16.16l-1.4.86A.75.75 0 0 1 3 16.39l1-12.64Zm3.25 3.5a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5Zm0 3a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function RefreshIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path
        fillRule="evenodd"
        d="M15.31 4.44a.75.75 0 0 1 1.06.05l1.75 1.94a.75.75 0 0 1-.02 1L16.2 9.4a.75.75 0 0 1-1.12-1l.6-.66A6 6 0 0 0 4.28 10a6 6 0 0 0 6.4 5.7.75.75 0 0 1 .14 1.5 7.5 7.5 0 0 1-8-7.13 7.5 7.5 0 0 1 13.4-4.72l.35-.39a.75.75 0 0 1 1.06-.05l-.32 .53Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
