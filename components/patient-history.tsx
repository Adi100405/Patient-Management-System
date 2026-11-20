import Link from "next/link";
import { Receipt } from "lucide-react";
import { RefundStatusLine } from "@/components/refund-status";
import { VisitDetails } from "@/components/visit-details";
import { Badge } from "@/components/ui/badge";
import type { AppointmentStatus } from "@/db/schema";
import type { RefundRecord } from "@/lib/refunds/queries";
import { visitWhenLabel } from "@/lib/schedule";
import { formatDate } from "@/lib/utils";

/**
 * One patient's own visit history, newest first, grouped by month.
 *
 * Completed visits carry the clinical detail the doctor recorded; cancelled and
 * missed rows keep the payment and refund trail instead. The same component
 * serves both sections, so the two never drift apart visually.
 */

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

export type PatientHistoryRow = {
  readonly id: number;
  readonly date: string;
  readonly time: string;
  readonly status: AppointmentStatus;
  readonly reason: string | null;
  readonly doctorName: string;
  readonly specialization: string;
  readonly schedulingType: "wave" | "stream" | null;
  readonly windowEnd: string | null;
  readonly paymentStatus: string | null;
  readonly paymentId: number | null;
  readonly paymentAmount: string | null;
  readonly paymentFailure: string | null;
  readonly diagnosis: string | null;
  readonly summary: string | null;
  readonly aftercare: string | null;
  readonly followUpDays: number | null;
};

export function PatientHistory({
  rows,
  refundsByPayment,
  emptyMessage,
}: {
  rows: readonly PatientHistoryRow[];
  refundsByPayment: ReadonlyMap<number, readonly RefundRecord[]>;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-5 text-sm text-ink-500">
        {emptyMessage}
      </p>
    );
  }

  const byMonth: { key: string; label: string; rows: PatientHistoryRow[] }[] = [];
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    const existing = byMonth.find((group) => group.key === key);
    if (existing) {
      existing.rows.push(row);
    } else {
      byMonth.push({
        key,
        label: new Date(`${row.date}T00:00:00`).toLocaleDateString("en-IN", {
          month: "long",
          year: "numeric",
        }),
        rows: [row],
      });
    }
  }

  return (
    <div className="space-y-6">
      {byMonth.map((group) => (
        <section key={group.key} className="space-y-2.5">
          <div className="flex items-center gap-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              {group.label}
            </h3>
            <span aria-hidden="true" className="h-px flex-1 bg-cream-200" />
            <span className="text-[11px] tabular-nums text-ink-500">
              {group.rows.length} {group.rows.length === 1 ? "visit" : "visits"}
            </span>
          </div>

          <ol className="space-y-2">
            {group.rows.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-cream-200 bg-white p-3.5 transition-colors hover:border-teal-200 hover:bg-teal-50/20"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-cream-100 text-xs font-semibold text-ink-700 ring-1 ring-inset ring-cream-200"
                    >
                      {initials(row.doctorName)}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-ink-900">
                          Dr. {row.doctorName}
                        </p>
                        <Badge variant={statusVariant[row.status]}>
                          {statusLabel[row.status]}
                        </Badge>
                      </div>
                      <p className="text-xs text-ink-500">{row.specialization}</p>
                      <p className="mt-1 text-xs tabular-nums text-ink-600">
                        {formatDate(row.date)} ·{" "}
                        {visitWhenLabel({
                          schedulingType: row.schedulingType ?? "wave",
                          time: row.time,
                          windowEnd: row.windowEnd,
                        })}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[3.25rem] sm:justify-end sm:pl-0">
                    {row.paymentStatus === "succeeded" && (
                      <span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium tabular-nums text-teal-800 ring-1 ring-inset ring-teal-200">
                        Paid ₹{Number(row.paymentAmount).toFixed(0)}
                      </span>
                    )}
                    {row.paymentStatus === "partially_refunded" && (
                      <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
                        Partly refunded
                      </span>
                    )}
                    {row.paymentStatus === "refunded" && (
                      <span className="rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium text-ink-700 ring-1 ring-inset ring-cream-200">
                        Refunded
                      </span>
                    )}
                    {row.paymentStatus === "failed" && row.paymentFailure && (
                      <span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
                        {row.paymentFailure === "checkout_expired"
                          ? "Payment expired"
                          : row.paymentFailure === "cancelled_by_patient"
                            ? "Cancelled before payment"
                            : "Payment failed"}
                      </span>
                    )}
                    <RefundStatusLine
                      refunds={[...(refundsByPayment.get(row.paymentId ?? -1) ?? [])]}
                    />
                    {(row.paymentStatus === "succeeded" ||
                      row.paymentStatus === "partially_refunded" ||
                      row.paymentStatus === "refunded") &&
                      row.paymentId !== null && (
                        <Link
                          href={`/dashboard/patient/receipts/${row.paymentId}`}
                          className="inline-flex items-center gap-1 rounded-full border border-cream-300 px-2.5 py-1 text-xs font-medium text-teal-700 transition-colors hover:border-teal-300 hover:bg-teal-50"
                        >
                          <Receipt className="h-3 w-3" aria-hidden="true" />
                          Receipt
                        </Link>
                      )}
                  </div>
                </div>

                {row.status === "completed" && (
                  <VisitDetails details={row} className="mt-3" />
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
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
