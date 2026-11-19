import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  diffMedicalRecords,
  EMPTY_MEDICAL_RECORD,
  MEDICAL_RECORD_FIELDS,
  medicalAuthorLabel,
  medicalValueLabel,
} from "@/lib/medical-history";
import type { MedicalHistoryRevision } from "@/lib/medical-history-data";
import { formatClinicTimestamp } from "@/lib/slots";

/**
 * The current medical record plus the trail of earlier revisions.
 *
 * The current revision is read from the newest row; every older row is shown
 * as the change it introduced. "Not recorded" is used for null values, so a
 * blank field never reads as "no allergies".
 */
export function MedicalHistoryCard({
  revisions,
}: {
  revisions: readonly MedicalHistoryRevision[];
}) {
  const current = revisions[0] ?? null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Medical history</CardTitle>
            <p className="text-sm text-ink-500">
              The current record, with every earlier version kept as an audit trail.
            </p>
          </div>
          {current && (
            <span className="shrink-0 rounded-full bg-cream-100 px-2.5 py-1 text-xs font-medium tabular-nums text-ink-600 ring-1 ring-inset ring-cream-200">
              {revisions.length} {revisions.length === 1 ? "revision" : "revisions"}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {!current ? (
          <div className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-6 text-center">
            <p className="text-sm font-medium text-ink-800">Nothing recorded yet</p>
            <p className="mt-1 text-sm text-ink-500">
              Add the patient&rsquo;s blood group, allergies, conditions and medications
              below. The first save becomes revision one.
            </p>
          </div>
        ) : (
          <>
            <div>
              <p className="text-xs text-ink-500">
                Last updated by{" "}
                <span className="font-medium text-ink-700">
                  {medicalAuthorLabel(current.recordedByName, current.recordedByRole)}
                </span>{" "}
                · {formatClinicTimestamp(current.createdAt)}
              </p>

              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                {MEDICAL_RECORD_FIELDS.map((field) => (
                  <div
                    key={field.key}
                    className="rounded-xl border border-cream-200 bg-white p-3.5"
                  >
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                      {field.label}
                    </dt>
                    <dd
                      className={
                        current[field.key] === null
                          ? "mt-1 text-sm italic text-ink-500"
                          : "mt-1 whitespace-pre-line text-sm text-ink-800"
                      }
                    >
                      {medicalValueLabel(current[field.key])}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <details className="rounded-xl border border-cream-200 bg-cream-50/40 px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-teal-800">
                Update history
              </summary>
              {revisions.length <= 1 ? (
                <p className="mt-3 text-sm text-ink-500">
                  This is the first recorded version. Later saves will appear here as
                  changes.
                </p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {revisions.slice(1).map((revision, index) => {
                    const older = revisions[index + 2] ?? EMPTY_MEDICAL_RECORD;
                    const changes = diffMedicalRecords(older, revision);

                    return (
                      <li
                        key={revision.id}
                        className="rounded-lg border border-cream-200 bg-white p-3"
                      >
                        <p className="text-xs text-ink-500">
                          <span className="font-medium text-ink-700">
                            {medicalAuthorLabel(
                              revision.recordedByName,
                              revision.recordedByRole,
                            )}
                          </span>{" "}
                          · {formatClinicTimestamp(revision.createdAt)}
                        </p>
                        {changes.length === 0 ? (
                          <p className="mt-2 text-sm text-ink-500">No recorded changes.</p>
                        ) : (
                          <ul className="mt-2 space-y-1.5">
                            {changes.map((change) => (
                              <li key={change.field} className="text-sm text-ink-700">
                                <span className="font-medium">{change.label}:</span>{" "}
                                <span className="text-ink-500">
                                  {medicalValueLabel(change.before)}
                                </span>{" "}
                                <span aria-hidden="true" className="text-ink-400">
                                  →
                                </span>{" "}
                                <span className="text-ink-800">
                                  {medicalValueLabel(change.after)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
