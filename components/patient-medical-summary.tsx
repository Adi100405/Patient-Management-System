import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  MEDICAL_RECORD_FIELDS,
  medicalAuthorLabel,
  medicalValueLabel,
} from "@/lib/medical-history";
import type { MedicalHistoryRevision } from "@/lib/medical-history-data";
import { formatClinicTimestamp } from "@/lib/slots";

/**
 * The patient's own view of their medical record: read-only, and only their
 * own. It is the same snapshot the doctor sees, in the same words, minus the
 * edit controls.
 */
export function PatientMedicalSummary({
  current,
}: {
  current: MedicalHistoryRevision | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>My medical record</CardTitle>
        <p className="text-sm text-ink-500">
          What your care team has on file. Only you and a doctor you have an
          appointment with can see this.
        </p>
      </CardHeader>
      <CardContent>
        {!current ? (
          <div className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 p-5">
            <p className="text-sm font-medium text-ink-800">Nothing recorded yet</p>
            <p className="mt-1 text-sm text-ink-500">
              Your doctor records allergies, conditions and medications during your
              visits. If something is missing, mention it at your next appointment.
            </p>
          </div>
        ) : (
          <>
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
