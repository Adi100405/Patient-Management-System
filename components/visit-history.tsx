import { Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AppointmentStatus } from "@/db/schema";
import { formatDate, formatTime } from "@/lib/utils";

/**
 * One patient's whole visit trail, as the treating doctor sees it.
 *
 * Every doctor in the clinic is included, not just the viewer: a care
 * relationship is what grants access to the page, and a partial history would
 * hide exactly the context the record exists to provide.
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

export type VisitHistoryRow = {
  readonly id: number;
  readonly date: string;
  readonly time: string;
  readonly status: AppointmentStatus;
  readonly reason: string | null;
  readonly tokenNumber: number | null;
  readonly doctorName: string;
  readonly specialization: string;
  readonly aftercare: string | null;
  readonly followUpDays: number | null;
};

export function VisitHistory({ rows }: { rows: readonly VisitHistoryRow[] }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Visit history</CardTitle>
            <p className="text-sm text-ink-500">
              Every appointment on file, newest first — including visits with other
              doctors in the clinic.
            </p>
          </div>
          {rows.length > 0 && (
            <span className="shrink-0 rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium tabular-nums text-ink-600 ring-1 ring-inset ring-cream-200">
              {rows.length} {rows.length === 1 ? "visit" : "visits"}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-5 text-sm text-ink-500">
            No appointments on file for this patient yet.
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-cream-200 bg-white p-3.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-ink-900">Dr. {row.doctorName}</p>
                      <Badge variant={statusVariant[row.status]}>
                        {statusLabel[row.status]}
                      </Badge>
                    </div>
                    <p className="text-xs text-teal-700">{row.specialization}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-ink-600">
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />
                        {formatDate(row.date)} · {formatTime(row.time)}
                      </span>
                      {row.tokenNumber !== null && (
                        <span className="rounded-full bg-cream-100 px-2 py-0.5 font-medium text-ink-600 ring-1 ring-inset ring-cream-200">
                          Token {row.tokenNumber}
                        </span>
                      )}
                    </p>
                    {row.reason && (
                      <p className="mt-1 text-xs text-ink-500">
                        Reason: <span className="text-ink-700">{row.reason}</span>
                      </p>
                    )}
                  </div>
                </div>

                {row.status === "completed" &&
                  (row.aftercare || row.followUpDays !== null) && (
                    <div className="mt-3 space-y-2 rounded-lg border border-cream-200 bg-cream-50/60 px-3 py-2">
                      {row.aftercare && (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                            Aftercare
                          </p>
                          <p className="mt-1 whitespace-pre-line text-sm text-ink-700">
                            {row.aftercare}
                          </p>
                        </div>
                      )}
                      {row.followUpDays !== null && (
                        <p className="text-xs text-ink-600">
                          Follow-up advised in {row.followUpDays}{" "}
                          {row.followUpDays === 1 ? "day" : "days"}.
                        </p>
                      )}
                    </div>
                  )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
