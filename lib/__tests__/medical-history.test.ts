import { describe, expect, it } from "vitest";
import {
  diffMedicalRecords,
  EMPTY_MEDICAL_RECORD,
  medicalAuthorLabel,
  medicalValueLabel,
  MEDICAL_TEXT_LIMITS,
  normalizeMedicalRecord,
  recordsEqual,
} from "@/lib/medical-history";

describe("normalizeMedicalRecord — what a save may contain", () => {
  it("trims values and turns blank fields into unrecorded, not empty strings", () => {
    const record = normalizeMedicalRecord({
      bloodGroup: "o+",
      allergies: "  Penicillin  ",
      conditions: "   ",
      medications: "",
      notes: "Prefers morning visits",
    });

    expect(record).toEqual({
      bloodGroup: "O+",
      allergies: "Penicillin",
      conditions: null,
      medications: null,
      notes: "Prefers morning visits",
    });
  });

  it("accepts the standard blood groups in any case and spacing", () => {
    expect(normalizeMedicalRecord({ bloodGroup: "ab +" }).bloodGroup).toBe("AB+");
    expect(normalizeMedicalRecord({ bloodGroup: "B-" }).bloodGroup).toBe("B-");
  });

  it("leaves an unrecognised blood group unrecorded instead of failing the save", () => {
    expect(normalizeMedicalRecord({ bloodGroup: "C+" }).bloodGroup).toBeNull();
    expect(normalizeMedicalRecord({ bloodGroup: 42 }).bloodGroup).toBeNull();
  });

  it("treats a missing field as unrecorded", () => {
    expect(normalizeMedicalRecord({})).toEqual(EMPTY_MEDICAL_RECORD);
  });

  it("clamps long text to the stored limit", () => {
    const long = "x".repeat(MEDICAL_TEXT_LIMITS.notes + 50);
    expect(normalizeMedicalRecord({ notes: long }).notes).toHaveLength(
      MEDICAL_TEXT_LIMITS.notes,
    );
  });
});

describe("recordsEqual — a no-op save writes no revision", () => {
  it("is true for identical snapshots", () => {
    const a = normalizeMedicalRecord({ allergies: "Penicillin", bloodGroup: "O+" });
    const b = normalizeMedicalRecord({ allergies: "Penicillin", bloodGroup: "O+" });
    expect(recordsEqual(a, b)).toBe(true);
  });

  it("is false when any field changes, including a cleared one", () => {
    const before = normalizeMedicalRecord({ allergies: "Penicillin" });
    const after = normalizeMedicalRecord({ allergies: "" });
    expect(recordsEqual(before, after)).toBe(false);
  });
});

describe("diffMedicalRecords — the audit line for each update", () => {
  it("names the field and keeps the before and after values", () => {
    const before = normalizeMedicalRecord({
      allergies: "Penicillin",
      medications: "Amlodipine 5 mg",
    });
    const after = normalizeMedicalRecord({
      allergies: "Penicillin, sulfa drugs",
      medications: "Amlodipine 5 mg",
      conditions: "Mild hypertension",
    });

    expect(diffMedicalRecords(before, after)).toEqual([
      {
        field: "allergies",
        label: "Allergies",
        before: "Penicillin",
        after: "Penicillin, sulfa drugs",
      },
      {
        field: "conditions",
        label: "Existing conditions",
        before: null,
        after: "Mild hypertension",
      },
    ]);
  });

  it("reports a cleared field as a change to unrecorded", () => {
    const before = normalizeMedicalRecord({ notes: "Reviewed in October" });
    const after = normalizeMedicalRecord({ notes: null });

    expect(diffMedicalRecords(before, after)[0]).toMatchObject({
      field: "notes",
      before: "Reviewed in October",
      after: null,
    });
  });

  it("is empty for identical records", () => {
    expect(diffMedicalRecords(EMPTY_MEDICAL_RECORD, EMPTY_MEDICAL_RECORD)).toHaveLength(0);
  });
});

describe("reading values", () => {
  it("says 'Not recorded' rather than implying a negative answer", () => {
    expect(medicalValueLabel(null)).toBe("Not recorded");
    expect(medicalValueLabel("Penicillin")).toBe("Penicillin");
  });

  it("labels a doctor with a title and everyone else by name", () => {
    expect(medicalAuthorLabel("Aarav Mehta", "doctor")).toBe("Dr. Aarav Mehta");
    expect(medicalAuthorLabel("Dr. Aarav Mehta", "doctor")).toBe("Dr. Aarav Mehta");
    expect(medicalAuthorLabel("Meera Iyer", "receptionist")).toBe("Meera Iyer");
  });
});
