import { cn } from "@/lib/utils";

/**
 * The clinical detail of one completed visit, shown in the same words on the
 * doctor's patient record and the patient's own dashboard.
 *
 * Every field is optional. When none was recorded the block renders nothing
 * rather than an empty heading, so a plain completed visit stays a plain row.
 */
export type VisitDetailsData = {
  readonly diagnosis: string | null;
  readonly summary: string | null;
  readonly aftercare: string | null;
  readonly followUpDays: number | null;
};

export function VisitDetails({
  details,
  className,
}: {
  details: VisitDetailsData;
  className?: string;
}) {
  const { diagnosis, summary, aftercare, followUpDays } = details;
  const hasAny =
    diagnosis !== null ||
    summary !== null ||
    aftercare !== null ||
    followUpDays !== null;

  if (!hasAny) return null;

  return (
    <div
      className={cn(
        "space-y-2.5 rounded-lg border border-cream-200 bg-cream-50/60 px-3 py-2.5",
        className,
      )}
    >
      {diagnosis && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Diagnosis
          </p>
          <p className="mt-0.5 whitespace-pre-line text-sm text-ink-800">{diagnosis}</p>
        </div>
      )}
      {summary && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Visit summary
          </p>
          <p className="mt-0.5 whitespace-pre-line text-sm text-ink-700">{summary}</p>
        </div>
      )}
      {aftercare && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Aftercare
          </p>
          <p className="mt-0.5 whitespace-pre-line text-sm text-ink-700">{aftercare}</p>
        </div>
      )}
      {followUpDays !== null && (
        <p className="text-xs text-ink-600">
          Follow-up advised in {followUpDays} {followUpDays === 1 ? "day" : "days"}.
        </p>
      )}
    </div>
  );
}
