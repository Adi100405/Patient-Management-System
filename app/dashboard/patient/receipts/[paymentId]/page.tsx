import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, doctors, payments } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PrintButton } from "@/components/print-button";
import { refundsForPayment } from "@/lib/refunds/queries";
import { requireRole } from "@/lib/session";
import { formatCurrency, formatDate, formatTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Receipt — Medrella" };

const paymentStatusLabel = {
  pending: "Payment pending",
  succeeded: "Paid in full",
  failed: "Payment failed",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
} as const;

const paymentStatusVariant = {
  pending: "no_show",
  succeeded: "completed",
  failed: "cancelled",
  partially_refunded: "no_show",
  refunded: "default",
} as const;

const refundStatusLabel = {
  pending: "Queued",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
} as const;

/**
 * Patient-facing receipt: what was charged, against which appointment, and the
 * true state of any refund. Scoped to the signed-in patient, so a receipt id
 * from someone else's booking returns 404 rather than leaking their details.
 */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const session = await requireRole("patient");
  const { paymentId } = await params;
  const id = Number(paymentId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const db = getDb();
  const [row] = await db
    .select({
      paymentId: payments.id,
      status: payments.status,
      amount: payments.amount,
      currency: payments.currency,
      provider: payments.provider,
      providerPaymentId: payments.providerPaymentId,
      createdAt: payments.createdAt,
      paidAt: payments.paidAt,
      appointmentDate: appointments.appointmentDate,
      appointmentTime: appointments.appointmentTime,
      doctorName: doctors.fullName,
      specialization: doctors.specialization,
    })
    .from(payments)
    .innerJoin(appointments, eq(appointments.id, payments.appointmentId))
    .innerJoin(doctors, eq(doctors.id, payments.doctorId))
    .where(and(eq(payments.id, id), eq(payments.patientId, session.profileId)))
    .limit(1);

  if (!row) notFound();

  const refunds = await refundsForPayment(row.paymentId);
  const refunded = refunds
    .filter((refund) => refund.status === "completed")
    .reduce((sum, refund) => sum + Number(refund.amount), 0);
  const refunding = refunds
    .filter((refund) => refund.status === "pending" || refund.status === "processing")
    .reduce((sum, refund) => sum + Number(refund.amount), 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/dashboard/patient" className="text-sm font-medium text-teal-700 hover:underline">
          ← Back to my appointments
        </Link>
        <PrintButton />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-xl">Payment receipt</CardTitle>
              <p className="text-sm text-ink-500">
                Receipt RCPT-{String(row.paymentId).padStart(6, "0")} · Medrella Clinic
              </p>
            </div>
            <Badge variant={paymentStatusVariant[row.status]}>
              {paymentStatusLabel[row.status]}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 text-sm">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Patient</dt>
              <dd className="font-medium text-ink-900">{session.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Doctor</dt>
              <dd className="font-medium text-ink-900">
                Dr. {row.doctorName} · {row.specialization}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Appointment</dt>
              <dd className="text-ink-800">
                {formatDate(row.appointmentDate)} at {formatTime(row.appointmentTime)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">
                {row.paidAt ? "Paid on" : "Created"}
              </dt>
              <dd className="text-ink-800">
                {formatDate(row.paidAt ?? row.createdAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Consultation fee</dt>
              <dd className="font-medium text-ink-900">
                {formatCurrency(row.amount)} {row.currency}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Refunded</dt>
              <dd className="font-medium text-ink-900">
                {refunded > 0
                  ? `${formatCurrency(refunded)} ${row.currency}`
                  : refunding > 0
                    ? `None yet — ${formatCurrency(refunding)} ${row.currency} in progress`
                    : "None"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Payment reference</dt>
              <dd className="font-mono text-xs text-ink-700">{row.providerPaymentId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Gateway</dt>
              <dd className="text-ink-800">{row.provider}</dd>
            </div>
          </dl>

          <div className="border-t border-cream-200 pt-4">
            <h2 className="text-sm font-semibold text-ink-900">Refunds</h2>
            {refunds.length === 0 ? (
              <p className="mt-2 text-sm text-ink-600">No refunds recorded for this payment.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {refunds.map((refund) => (
                  <li
                    key={refund.id}
                    className="rounded-xl border border-cream-200 p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink-900">
                        {formatCurrency(refund.amount)} {refund.currency}
                      </span>
                      <Badge variant={refund.status === "completed" ? "completed" : refund.status === "failed" ? "cancelled" : "no_show"}>
                        {refundStatusLabel[refund.status]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-600">{refund.note ?? refund.reason}</p>
                    <p className="mt-1 font-mono text-[11px] text-ink-500">
                      {refund.providerRefundId ?? "awaiting gateway reference"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-500">
              Refunds return to the original payment method. Banks typically take 3–5 working days
              after the gateway reports completion.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
