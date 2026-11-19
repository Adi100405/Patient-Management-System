import Link from "next/link";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { after } from "next/server";
import { AlertTriangle, Calendar, Check, Clock, Receipt, RefreshCw } from "lucide-react";
import { getDb } from "@/db";
import { appointments, availability, doctors, patients, payments, users, visitNotes } from "@/db/schema";
import type { AppointmentStatus } from "@/db/schema";
import { AssistantWidget } from "@/components/assistant/assistant-widget";
import { CancelAppointment } from "@/components/cancel-appointment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentCheckout } from "@/components/payment-checkout";
import { NotificationPreferences } from "@/components/notification-preferences";
import { PatientHistory } from "@/components/patient-history";
import { PatientMedicalSummary } from "@/components/patient-medical-summary";
import { QueueStatus } from "@/components/queue-status";
import { RescheduleAppointment, type RescheduleDayOption } from "@/components/reschedule-appointment";
import { blocksForDoctors } from "@/lib/availability";
import { describeCancellation } from "@/lib/cancel-preview";
import { latestMedicalHistory } from "@/lib/medical-history-data";
import { refundsForPatient } from "@/lib/refunds/queries";
import { patientQueueStatus } from "@/lib/queue-data";
import { preferencesForUser } from "@/lib/notifications/preferences";
import { sweepReminders } from "@/lib/notifications/reminders";
import { sweepCareFollowUps } from "@/lib/notifications/care";
import { requireRole } from "@/lib/session";
import { clinicNow, dayOption, upcomingDays, type DayOption } from "@/lib/slots";
import { offersFor, openDates, visitWhenLabel } from "@/lib/schedule";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Patient dashboard — Medrella" };

const statusVariant = {
  booked: "booked",
  cancelled: "cancelled",
  completed: "completed",
  no_show: "no_show",
  needs_rebooking: "needs_rebooking",
} as const;

const statusLabel: Record<AppointmentStatus, string> = {
  booked: "Booked",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
  needs_rebooking: "Needs rebooking",
};

/**
 * How an appointment reads as its time: a stream books the window as one item,
 * so it reads as a start–end range; a wave — or a row whose window block has
 * since been deleted — reads as its start time.
 */
function visitWhen(row: {
  readonly time: string;
  readonly schedulingType: "wave" | "stream" | null;
  readonly windowEnd: string | null;
}) {
  return visitWhenLabel({
    schedulingType: row.schedulingType ?? "wave",
    time: row.time,
    windowEnd: row.windowEnd,
  });
}

export default async function PatientDashboard() {
  const session = await requireRole("patient");

  // Reminders and post-visit care are derived from live state, but they are
  // writes triggered by a page read — so they run AFTER the response is sent.
  // The dashboard paints without waiting on them, and the daily cron remains
  // the backstop if a sweep is ever skipped.
  after(async () => {
    await Promise.allSettled([sweepReminders(), sweepCareFollowUps()]);
  });
  const db = getDb();

  const rows = await db
    .select({
      id: appointments.id,
      doctorId: appointments.doctorId,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      status: appointments.status,
      reason: appointments.reason,
      schedulingType: availability.schedulingType,
      windowEnd: availability.endTime,
      doctorName: doctors.fullName,
      specialization: doctors.specialization,
      fee: doctors.consultationFee,
      paymentStatus: payments.status,
      paymentId: payments.id,
      paymentAmount: payments.amount,
      paymentCurrency: payments.currency,
      paymentProvider: payments.provider,
      paymentFailure: payments.failureReason,
      clinicMoved: appointments.clinicMoved,
      checkedInAt: appointments.checkedInAt,
      tokenNumber: appointments.tokenNumber,
      servingStartedAt: appointments.servingStartedAt,
      diagnosis: visitNotes.diagnosis,
      summary: visitNotes.summary,
      aftercare: visitNotes.aftercare,
      followUpDays: visitNotes.followUpDays,
    })
    .from(appointments)
    .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
    .leftJoin(availability, eq(appointments.availabilityId, availability.id))
    .leftJoin(payments, eq(payments.appointmentId, appointments.id))
    .leftJoin(visitNotes, eq(visitNotes.appointmentId, appointments.id))
    .where(eq(appointments.patientId, session.profileId))
    .orderBy(
      asc(appointments.appointmentDate),
      asc(appointments.appointmentTime),
      asc(appointments.seatNumber),
    );

  const refundsByPayment = await refundsForPatient(session.profileId);
  const medicalRecord = await latestMedicalHistory(session.profileId);

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
  // Where this patient's own visit stands in the queue today: their token and
  // their place, never anybody else's name.
  const queueStatus = await patientQueueStatus(session.profileId, today);
  // A displaced visit with no slot is not history: the patient still owes the
  // clinic a decision, so it gets its own action card above the diary.
  const needsRebooking = rows.filter((r) => r.status === "needs_rebooking");
  const active = [...upcoming, ...needsRebooking];
  // Completed visits get their own section: they carry the clinical notes and
  // are what the task means by "visit history". Everything else already past
  // (cancelled, missed, or an unresolved earlier booking) keeps its payment
  // trail in a separate section.
  const completed = rows.filter((r) => r.status === "completed").reverse();
  const past = rows
    .filter(
      (r) =>
        r.status !== "completed" &&
        r.status !== "needs_rebooking" &&
        !upcoming.includes(r),
    )
    .reverse();

  // Free-slot options for rescheduling, computed once per doctor (not per
  // row) with the same availability logic the booking page uses. The patient's
  // own current slot is excluded from the booked set, so a day tab can show it
  // again if it is otherwise free.
  const rescheduleDays = new Map<number, RescheduleDayOption[]>();
  const doctorIds = [...new Set(active.map((r) => r.doctorId))];
  const days7 = upcomingDays(7);
  const horizon = upcomingDays(60);
  const horizonEnd = horizon[horizon.length - 1]?.date ?? days7[days7.length - 1]!.date;
  if (doctorIds.length > 0) {
    const blocksByDoctor = await blocksForDoctors(doctorIds);
    const horizonStart = days7[0]!.date;
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

    // Seats taken per doctor, per date, per time.
    const takenByDoctor = new Map<string, Map<string, number>>();
    for (const booked of allBooked) {
      const key = `${booked.doctorId}|${booked.date}`;
      const byTime = takenByDoctor.get(key) ?? new Map<string, number>();
      byTime.set(booked.time, (byTime.get(booked.time) ?? 0) + 1);
      takenByDoctor.set(key, byTime);
    }

    const now = clinicNow();
    for (const row of active) {
      const doctorBlocks = blocksByDoctor.get(row.doctorId) ?? [];
      const candidates = new Map<string, DayOption>();
      for (const day of days7) candidates.set(day.date, day);
      for (const block of doctorBlocks) {
        for (const date of block.dates) {
          if (date < now.date || date > horizonEnd) continue;
          if (!candidates.has(date)) candidates.set(date, dayOption(date));
        }
      }

      rescheduleDays.set(
        row.id,
        openDates(
          doctorBlocks,
          [...candidates.values()].sort((a, b) => a.date.localeCompare(b.date)),
        ).map((day) => {
          // The appointment being rescheduled is not its own competitor, so its
          // own seat is given back before the tally is read. A needs-rebooking
          // row has already released its old seat, so there is nothing to give
          // back and doing so would invent a free seat at the old time.
          const taken = new Map(
            takenByDoctor.get(`${row.doctorId}|${day.date}`) ?? new Map<string, number>(),
          );
          if (row.status === "booked" && day.date === row.date) {
            const own = taken.get(row.time);
            if (own !== undefined) taken.set(row.time, own - 1);
          }

          return {
            date: day.date,
            label: day.label,
            isToday: day.isToday,
            slots: offersFor({
              blocks: doctorBlocks,
              date: day.date,
              takenSeats: taken,
              now,
            })
              .filter((offer) => offer.free > 0)
              .map((offer) => ({
                time: offer.time,
                endTime: offer.endTime,
                free: offer.free,
                seats: offer.seats,
                schedulingType: offer.schedulingType,
              })),
          };
        }),
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
            { label: "Upcoming", value: upcoming.length, tone: "text-teal-800", icon: <Calendar className="h-4 w-4" /> },
            { label: "Awaiting payment", value: awaitingPayment, tone: "text-amber-700", icon: <Clock className="h-4 w-4" /> },
            { label: "Completed visits", value: completed.length, tone: "text-ink-900", icon: <Check className="h-4 w-4" /> },
            { label: "Paid to date", value: `₹${paidTotal.toFixed(0)}`, tone: "text-teal-800", icon: <Receipt className="h-4 w-4" /> },
            { label: "Refunds in progress", value: refundsInProgress, tone: "text-rose-700", icon: <RefreshCw className="h-4 w-4" /> },
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

      {needsRebooking.length > 0 && (
        <Card className="border-rose-200">
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-100 text-rose-700">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <CardTitle>Choose a new time</CardTitle>
                <p className="text-sm text-ink-500">
                  The clinic changed its schedule and could not fit these visits into another slot
                  within seven days. Pick a new time — or cancel for a full refund.
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {needsRebooking.map((row) => {
              const days = rescheduleDays.get(row.id) ?? [];
              const canReschedule = days.some((day) => day.slots.length > 0);

              return (
                <div
                  key={row.id}
                  className="space-y-3 rounded-2xl border border-rose-200 bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="font-semibold text-ink-900">
                        Dr. {row.doctorName}{" "}
                        <span className="text-sm font-normal text-teal-700">
                          · {row.specialization}
                        </span>
                      </p>
                      <p className="text-xs text-ink-500">
                        Previous visit:{" "}
                        <span className="tabular-nums text-ink-700">
                          {formatDate(row.date)} · {visitWhen(row)}
                        </span>
                      </p>
                    </div>
                    <Badge variant="needs_rebooking" className="shrink-0">
                      Needs rebooking
                    </Badge>
                  </div>

                  <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-800">
                    This visit has no time right now. Your payment is safe — rebooking keeps it,
                    and cancelling returns it in full because the clinic moved the visit.
                  </p>

                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-cream-100 pt-3">
                    {canReschedule && (
                      <RescheduleAppointment
                        appointmentId={row.id}
                        currentLabel="no time right now"
                        currentDate=""
                        currentTime=""
                        days={days}
                      />
                    )}
                    <CancelAppointment
                      appointmentId={row.id}
                      subject={`Dr. ${row.doctorName} · previous ${formatDate(row.date)} · ${visitWhen(row)}`}
                      preview={describeCancellation({
                        paymentStatus: row.paymentStatus,
                        paymentProvider: row.paymentProvider,
                        amount: row.paymentAmount,
                        date: row.date,
                        time: row.time,
                        clinicMoved: true,
                      })}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

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
                          <Calendar className="h-3.5 w-3.5 text-ink-500" />
                          {formatDate(row.date)} · {visitWhen(row)}
                        </span>
                        <PaymentChip row={row} />
                      </div>
                      {row.date === today && (
                        <QueueStatus
                          status={queueStatus.get(row.id) ?? null}
                          date={row.date}
                          time={row.time}
                        />
                      )}
                      {row.reason && (
                        <p className="text-xs text-ink-500">
                          Reason: <span className="text-ink-700">{row.reason}</span>
                        </p>
                      )}
                      {row.clinicMoved && (
                        <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs leading-relaxed text-amber-800">
                          <RefreshCw className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                          The clinic moved this visit to a new time. Keep it, reschedule, or cancel
                          for a full refund.
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
                  <CancelAppointment
                    appointmentId={row.id}
                    subject={`Dr. ${row.doctorName} · ${formatDate(row.date)} · ${visitWhen(row)}`}
                    preview={describeCancellation({
                      paymentStatus: row.paymentStatus,
                      paymentProvider: row.paymentProvider,
                      amount: row.paymentAmount,
                      date: row.date,
                      time: row.time,
                      clinicMoved: row.clinicMoved,
                    })}
                  />
                  {(rescheduleDays.get(row.id) ?? []).some(
                    (d) => d.slots.some((slot) => !(d.date === row.date && slot.time === row.time)),
                  ) && (
                    <RescheduleAppointment
                      appointmentId={row.id}
                      currentLabel={`${formatDate(row.date)} · ${visitWhen(row)}`}
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

      <PatientMedicalSummary current={medicalRecord} />

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Completed visits</CardTitle>
              <p className="text-sm text-ink-500">
                Finished consultations, with the diagnosis and notes your doctor recorded.
              </p>
            </div>
            {completed.length > 0 && (
              <span className="shrink-0 rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium tabular-nums text-ink-600 ring-1 ring-inset ring-cream-200">
                {completed.length} {completed.length === 1 ? "visit" : "visits"}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <PatientHistory
            rows={completed}
            refundsByPayment={refundsByPayment}
            emptyMessage="No completed visits yet — finished consultations will appear here."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Past appointments</CardTitle>
              <p className="text-sm text-ink-500">
                Cancelled, missed or closed without a completed visit, with their payment trail.
              </p>
            </div>
            {past.length > 0 && (
              <span className="shrink-0 rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium tabular-nums text-ink-600 ring-1 ring-inset ring-cream-200">
                {past.length} {past.length === 1 ? "visit" : "visits"}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <PatientHistory
            rows={past}
            refundsByPayment={refundsByPayment}
            emptyMessage="Nothing here yet — cancelled and missed appointments will appear here."
          />
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

      <AssistantWidget role="patient" name={session.name} userId={session.userId} />
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
        <Check className="h-3.5 w-3.5" />
        Paid ₹{amount} {currency}
      </span>
    );
  }
  if (row.paymentStatus === "pending" && row.paymentProvider !== "manual") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
        <Clock className="h-3.5 w-3.5" />
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
