/**
 * The shape of a patient's medical record and the rules for saving a revision.
 *
 * This module is deliberately pure: no database, no clock, no session. The
 * form, the server action and the audit diff all use the same rules, so a value
 * cannot be accepted in one place and rejected in another.
 *
 * A saved record is a full snapshot. Anything the doctor leaves blank is
 * `null` — "not recorded" — never an empty string, and never a silent "none".
 */

/** The blood groups a record may carry. Anything else is treated as unrecorded. */
export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/** Longest free text stored per field, so an accidental paste cannot balloon a row. */
export const MEDICAL_TEXT_LIMITS = {
  allergies: 2000,
  conditions: 2000,
  medications: 2000,
  notes: 4000,
} as const;

export type MedicalRecordFields = {
  readonly bloodGroup: BloodGroup | null;
  readonly allergies: string | null;
  readonly conditions: string | null;
  readonly medications: string | null;
  readonly notes: string | null;
};

/** The record before anything has been saved: every field is unrecorded. */
export const EMPTY_MEDICAL_RECORD: MedicalRecordFields = {
  bloodGroup: null,
  allergies: null,
  conditions: null,
  medications: null,
  notes: null,
};

/** Field order and labels shared by the form, the current-record card and the diff. */
export const MEDICAL_RECORD_FIELDS = [
  { key: "bloodGroup", label: "Blood group" },
  { key: "allergies", label: "Allergies" },
  { key: "conditions", label: "Existing conditions" },
  { key: "medications", label: "Current medications" },
  { key: "notes", label: "Other medical details" },
] as const;

export type MedicalRecordField = (typeof MEDICAL_RECORD_FIELDS)[number]["key"];

/** What a field reads as when it has never been recorded. */
export const NOT_RECORDED_LABEL = "Not recorded";

function normalizeText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

/**
 * Accepts the standard eight groups in any case and with stray spaces
 * ("ab +" becomes "AB+"). An unrecognised value is not an error: the field is
 * optional, so it simply stays unrecorded.
 */
export function normalizeBloodGroup(raw: unknown): BloodGroup | null {
  if (typeof raw !== "string") return null;
  const compact = raw.toUpperCase().replace(/\s+/g, "");
  return (BLOOD_GROUPS as readonly string[]).includes(compact)
    ? (compact as BloodGroup)
    : null;
}

export type MedicalRecordInput = {
  readonly bloodGroup?: unknown;
  readonly allergies?: unknown;
  readonly conditions?: unknown;
  readonly medications?: unknown;
  readonly notes?: unknown;
};

export function normalizeMedicalRecord(input: MedicalRecordInput): MedicalRecordFields {
  return {
    bloodGroup: normalizeBloodGroup(input.bloodGroup),
    allergies: normalizeText(input.allergies, MEDICAL_TEXT_LIMITS.allergies),
    conditions: normalizeText(input.conditions, MEDICAL_TEXT_LIMITS.conditions),
    medications: normalizeText(input.medications, MEDICAL_TEXT_LIMITS.medications),
    notes: normalizeText(input.notes, MEDICAL_TEXT_LIMITS.notes),
  };
}

/** True when a save would change nothing, so no new revision should be written. */
export function recordsEqual(a: MedicalRecordFields, b: MedicalRecordFields): boolean {
  return MEDICAL_RECORD_FIELDS.every((field) => a[field.key] === b[field.key]);
}

export type MedicalRecordChange = {
  readonly field: MedicalRecordField;
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
};

/**
 * Field-by-field changes between two snapshots, in form order. A cleared field
 * is a real change: `after` is null, which the UI reads as "Not recorded".
 */
export function diffMedicalRecords(
  previous: MedicalRecordFields,
  next: MedicalRecordFields,
): readonly MedicalRecordChange[] {
  const changes: MedicalRecordChange[] = [];
  for (const field of MEDICAL_RECORD_FIELDS) {
    const before = previous[field.key];
    const after = next[field.key];
    if (before !== after) {
      changes.push({ field: field.key, label: field.label, before, after });
    }
  }
  return changes;
}

/** "Aarav Mehta" + doctor → "Dr. Aarav Mehta"; anyone else keeps their own name. */
export function medicalAuthorLabel(name: string, role: string): string {
  const clean = name.replace(/^Dr\.?\s+/i, "").trim();
  return role === "doctor" ? `Dr. ${clean}` : clean;
}

/** A stored value as it should read, without ever implying a negative answer. */
export function medicalValueLabel(value: string | null): string {
  return value ?? NOT_RECORDED_LABEL;
}
