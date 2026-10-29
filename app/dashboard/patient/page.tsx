import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { cancelAppointment } from "@/actions/booking";
import { getDb } from "@/db";
import { appointments, doctors, payments } from "@/db/schema";
import type { AppointmentStatus } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentCheckout } from "@/components/payment-checkout";
import { RefundStatusLine } from "@/components/refund-status";
import { refundsForPatient } from "@/lib/refunds/queries";
import { sweepReminders } from "@/lib/notifications/reminders";
import { requireRole } from "@/lib/session";
import { clinicNow } from "@/lib/slots";
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
  booked: "booked",
  cancelled: "cancelled",
  completed: "completed",
  no_show: "no-show",
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

  const today = clinicNow().date;
  const upcoming = rows.filter((r) => r.status === "booked" && r.date >= today);
  const history = rows.filter((r) => !upcoming.includes(r)).reverse();

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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My appointments</h1>
        <p className="text-sm text-slate-600">
          Welcome back, {session.name}. Here is everything you have booked.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          { label: "Upcoming", value: upcoming.length },
          { label: "Awaiting payment", value: awaitingPayment },
          { label: "Total bookings", value: rows.length },
          { label: "Paid to date", value: `₹${paidTotal.toFixed(0)}` },
          { label: "Refunds in progress", value: refundsInProgress },
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
                  <p className="text-xs text-slate-500">
                    {row.paymentStatus === "succeeded" ? (
                      <span className="text-teal-700">
                        Paid ₹{Number(row.paymentAmount).toFixed(0)} {row.paymentCurrency}
                      </span>
                    ) : row.paymentProvider === "manual" || row.paymentStatus === null ? (
                      <>Fee ₹{Number(row.paymentAmount ?? row.fee).toFixed(0)} payable at the clinic</>
                    ) : (
                      <>
                        Fee ₹{Number(row.paymentAmount ?? row.fee).toFixed(0)} · payment pending
                      </>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant={statusVariant[row.status]}>{statusLabel[row.status]}</Badge>
                  {row.paymentStatus === "pending" && row.paymentProvider !== "manual" && (
                    <PaymentCheckout
                      appointmentId={row.id}
                      amount={String(row.paymentAmount ?? row.fee)}
                      currency={row.paymentCurrency ?? "INR"}
                    />
                  )}
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
                <div className="flex flex-wrap items-center justify-end gap-3">
                  {row.paymentStatus === "succeeded" && (
                    <span className="text-xs text-teal-700">
                      Paid ₹{Number(row.paymentAmount).toFixed(0)}
                    </span>
                  )}
                  {row.paymentStatus === "partially_refunded" && (
                    <span className="text-xs text-slate-600">Partly refunded</span>
                  )}
                  {row.paymentStatus === "refunded" && (
                    <span className="text-xs text-slate-600">Refund issued</span>
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
    </div>
  );
}
