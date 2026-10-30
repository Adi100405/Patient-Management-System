import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, doctors, patients, payments, users } from "@/db/schema";
import { PrintButton } from "@/components/print-button";
import { refundsForPayment } from "@/lib/refunds/queries";
import { requireRole } from "@/lib/session";
import { CLINIC_TIME_ZONE } from "@/lib/slots";
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

const paymentStatusTone = {
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  succeeded: "bg-teal-50 text-teal-800 ring-teal-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200",
  partially_refunded: "bg-cream-100 text-ink-700 ring-cream-200",
  refunded: "bg-cream-100 text-ink-700 ring-cream-200",
} as const;

const refundStatusLabel = {
  pending: "Queued",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
} as const;

const refundStatusTone = {
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  processing: "bg-amber-50 text-amber-800 ring-amber-200",
  completed: "bg-teal-50 text-teal-800 ring-teal-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200",
} as const;

/** "razorpay" → "Razorpay"; the ledger's machine name is not a brand name. */
function providerLabel(provider: string) {
  if (provider === "manual") return "Cash / card at the clinic";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** A timestamp as clinic wall-clock, e.g. "31 Oct 2026, 10:24 am". */
function formatTimestamp(date: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: CLINIC_TIME_ZONE,
  }).format(date);
}

/**
 * Patient-facing receipt: what was charged, against which appointment, and the
 * true state of any refund. Scoped to the signed-in patient, so a receipt id
 * from someone else's booking returns 404 rather than leaking their details.
 *
 * Laid out as a printable document first — letterhead, itemised fee, payment
 * details, footer — so "Print / Save as PDF" produces something a patient can
 * file with an insurer without any further fiddling.
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
      patientEmail: users.email,
    })
    .from(payments)
    .innerJoin(appointments, eq(appointments.id, payments.appointmentId))
    .innerJoin(doctors, eq(doctors.id, payments.doctorId))
    .innerJoin(patients, eq(patients.id, payments.patientId))
    .innerJoin(users, eq(users.id, patients.userId))
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

  const fee = Number(row.amount);
  const netPaid = Math.max(fee - refunded, 0);
  const receiptNo = `RCPT-${String(row.paymentId).padStart(6, "0")}`;
  const issuedAt = row.paidAt ?? row.createdAt;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link href="/dashboard/patient" className="text-sm font-medium text-teal-700 hover:underline">
          ← Back to my appointments
        </Link>
        <PrintButton />
      </div>

      <article className="overflow-hidden rounded-2xl border border-cream-200 bg-white shadow-sm">
        {/* Letterhead */}
        <header className="border-b-4 border-teal-700 bg-teal-700 px-6 py-6 text-white sm:px-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="grid h-11 w-11 place-items-center rounded-xl bg-white/15 text-lg font-bold ring-1 ring-inset ring-white/25"
              >
                M
              </span>
              <div>
                <p className="text-xl font-semibold tracking-tight">Medrella Clinic</p>
                <p className="text-xs text-teal-100">Consultation payment receipt</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wider text-teal-100">Receipt no.</p>
              <p className="font-mono text-sm font-semibold">{receiptNo}</p>
              <p className="mt-1 text-xs text-teal-100">{formatTimestamp(issuedAt)}</p>
            </div>
          </div>
        </header>

        <div className="space-y-7 px-6 py-6 text-sm sm:px-8">
          {/* Status strip */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${paymentStatusTone[row.status]}`}
            >
              <span aria-hidden="true">●</span>
              {paymentStatusLabel[row.status]}
            </span>
            <span className="text-xs text-ink-500">
              {row.provider === "manual"
                ? "Paid at the clinic"
                : `Paid securely via ${providerLabel(row.provider)}`}
            </span>
          </div>

          {/* Parties */}
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Billed to
              </h2>
              <p className="mt-2 font-semibold text-ink-900">{session.name}</p>
              <p className="text-xs text-ink-500">{row.patientEmail}</p>
            </div>
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Appointment
              </h2>
              <p className="mt-2 font-semibold text-ink-900">Dr. {row.doctorName}</p>
              <p className="text-xs text-ink-500">{row.specialization}</p>
              <p className="mt-1 text-xs text-ink-600">
                {formatDate(row.appointmentDate)} at {formatTime(row.appointmentTime)}
              </p>
            </div>
          </div>

          {/* Itemised amount */}
          <div className="overflow-hidden rounded-xl border border-cream-200">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-cream-200 bg-cream-50 text-[11px] uppercase tracking-wider text-ink-500">
                  <th className="px-4 py-2.5 font-semibold">Description</th>
                  <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">Appointment</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-100">
                <tr>
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink-900">Consultation fee</p>
                    <p className="text-xs text-ink-500">Dr. {row.doctorName} · {row.specialization}</p>
                  </td>
                  <td className="hidden px-4 py-3 text-ink-600 sm:table-cell">
                    {formatDate(row.appointmentDate)} at {formatTime(row.appointmentTime)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-ink-900 tabular-nums">
                    {formatCurrency(row.amount)} {row.currency}
                  </td>
                </tr>
                {refunded > 0 && (
                  <tr>
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-900">Refund issued</p>
                      <p className="text-xs text-ink-500">Returned to the original payment method</p>
                    </td>
                    <td className="hidden px-4 py-3 text-ink-600 sm:table-cell">—</td>
                    <td className="px-4 py-3 text-right font-medium text-teal-800 tabular-nums">
                      − {formatCurrency(refunded)} {row.currency}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink-900/10 bg-cream-50">
                  <td className="px-4 py-3 font-semibold text-ink-900" colSpan={2}>
                    {refunded > 0 ? "Net paid" : "Total paid"}
                  </td>
                  <td className="px-4 py-3 text-right text-base font-semibold text-ink-900 tabular-nums">
                    {formatCurrency(netPaid)} {row.currency}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Payment details */}
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Detail label="Payment method">{providerLabel(row.provider)}</Detail>
            <Detail label={row.paidAt ? "Paid on" : "Created on"}>
              {formatTimestamp(issuedAt)}
            </Detail>
            <Detail label="Gateway reference">
              <span className="font-mono text-xs">{row.providerPaymentId ?? "—"}</span>
            </Detail>
            <Detail label="Refund status">
              {refunded > 0
                ? `${formatCurrency(refunded)} ${row.currency} returned`
                : refunding > 0
                  ? `${formatCurrency(refunding)} ${row.currency} in progress`
                  : "No refunds"}
            </Detail>
          </div>

          {/* Refund trail */}
          {refunds.length > 0 && (
            <div className="border-t border-cream-200 pt-5">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Refund trail
              </h2>
              <ul className="mt-3 space-y-2.5">
                {refunds.map((refund) => (
                  <li
                    key={refund.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-200 bg-cream-50/60 px-3.5 py-2.5"
                  >
                    <div>
                      <p className="font-medium text-ink-900 tabular-nums">
                        {formatCurrency(refund.amount)} {refund.currency}
                      </p>
                      <p className="text-xs text-ink-600">{refund.note ?? refund.reason}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-ink-500">
                        {refund.providerRefundId ?? "awaiting gateway reference"}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${refundStatusTone[refund.status]}`}
                    >
                      {refundStatusLabel[refund.status]}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-500">
                Refunds return to the original payment method; banks typically take 3–5 working days
                after the gateway reports completion.
              </p>
            </div>
          )}
        </div>

        <footer className="border-t border-cream-200 bg-cream-50 px-6 py-4 text-center text-xs text-ink-500 sm:px-8">
          This is a computer-generated receipt and does not require a signature. Keep it for your
          records — you can re-print it any time from your dashboard. Get well soon!
        </footer>
      </article>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-cream-200 pb-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">{label}</span>
      <span className="text-right text-ink-800">{children}</span>
    </div>
  );
}
