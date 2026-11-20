"use client";

import { useActionState } from "react";
import { saveMedicalHistory, type MedicalHistoryState } from "@/actions/medical-history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  BLOOD_GROUPS,
  MEDICAL_TEXT_LIMITS,
  type MedicalRecordFields,
} from "@/lib/medical-history";

/**
 * The doctor's editor for a patient's medical record.
 *
 * Saving appends a revision; it never rewrites the previous one. The copy says
 * so, because "save" usually implies an overwrite and this is the one place
 * where that difference matters to the person clicking.
 */
export function MedicalHistoryForm({
  patientId,
  initial,
}: {
  patientId: number;
  initial: MedicalRecordFields;
}) {
  const [state, formAction, pending] = useActionState<MedicalHistoryState, FormData>(
    saveMedicalHistory,
    null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="patientId" value={patientId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bloodGroup">Blood group</Label>
          <select
            id="bloodGroup"
            name="bloodGroup"
            defaultValue={initial.bloodGroup ?? ""}
            className="flex h-10 w-full rounded-xl border border-cream-300 bg-white px-3 py-2 text-sm text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
          >
            <option value="">Not recorded</option>
            {BLOOD_GROUPS.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="allergies">Allergies</Label>
          <Input
            id="allergies"
            name="allergies"
            defaultValue={initial.allergies ?? ""}
            maxLength={MEDICAL_TEXT_LIMITS.allergies}
            placeholder="e.g. Penicillin, sulfa drugs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="conditions">Existing conditions</Label>
        <Textarea
          id="conditions"
          name="conditions"
          rows={2}
          defaultValue={initial.conditions ?? ""}
          maxLength={MEDICAL_TEXT_LIMITS.conditions}
          placeholder="e.g. Mild hypertension, type 2 diabetes"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="medications">Current medications</Label>
        <Textarea
          id="medications"
          name="medications"
          rows={2}
          defaultValue={initial.medications ?? ""}
          maxLength={MEDICAL_TEXT_LIMITS.medications}
          placeholder="e.g. Amlodipine 5 mg, once daily"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Other medical details</Label>
        <Textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={initial.notes ?? ""}
          maxLength={MEDICAL_TEXT_LIMITS.notes}
          placeholder="Anything else the next doctor should know"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-cream-100 pt-3">
        <p className="max-w-md text-xs text-ink-500">
          Every save adds a new revision. Earlier versions stay in the record, with who
          changed what and when.
        </p>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save new revision"}
        </Button>
      </div>

      <div aria-live="polite">
        {state?.error && <p className="text-xs text-rose-600">{state.error}</p>}
        {state?.message && <p className="text-xs text-teal-700">{state.message}</p>}
      </div>
    </form>
  );
}
