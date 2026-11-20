import { describe, expect, it } from "vitest";
import {
  MAX_AFTERCARE_LENGTH,
  MAX_DIAGNOSIS_LENGTH,
  MAX_FOLLOW_UP_DAYS,
  MAX_SUMMARY_LENGTH,
  normalizeAftercare,
  normalizeDiagnosis,
  normalizeFollowUpDays,
  normalizeVisitSummary,
} from "@/lib/visit-notes";

describe("visit note text", () => {
  it("trims and keeps a real value", () => {
    expect(normalizeDiagnosis("  Stable angina  ")).toBe("Stable angina");
    expect(normalizeVisitSummary("  ECG unchanged.  ")).toBe("ECG unchanged.");
    expect(normalizeAftercare("  Rest for 48 hours.  ")).toBe("Rest for 48 hours.");
  });

  it("turns blank, missing and non-string values into null", () => {
    for (const value of ["", "   ", null, undefined, 42]) {
      expect(normalizeDiagnosis(value)).toBeNull();
      expect(normalizeVisitSummary(value)).toBeNull();
      expect(normalizeAftercare(value)).toBeNull();
    }
  });

  it("clamps each field to its own limit", () => {
    expect(normalizeDiagnosis("x".repeat(MAX_DIAGNOSIS_LENGTH + 20))).toHaveLength(
      MAX_DIAGNOSIS_LENGTH,
    );
    expect(normalizeVisitSummary("x".repeat(MAX_SUMMARY_LENGTH + 20))).toHaveLength(
      MAX_SUMMARY_LENGTH,
    );
    expect(normalizeAftercare("x".repeat(MAX_AFTERCARE_LENGTH + 20))).toHaveLength(
      MAX_AFTERCARE_LENGTH,
    );
  });
});

describe("normalizeFollowUpDays", () => {
  it("accepts a whole number of days inside the year", () => {
    expect(normalizeFollowUpDays("14")).toBe(14);
    expect(normalizeFollowUpDays(" 1 ")).toBe(1);
    expect(normalizeFollowUpDays(String(MAX_FOLLOW_UP_DAYS))).toBe(MAX_FOLLOW_UP_DAYS);
  });

  it("silently drops anything that is not a usable interval", () => {
    for (const value of ["", "0", "-2", "2.5", "soon", String(MAX_FOLLOW_UP_DAYS + 1)]) {
      expect(normalizeFollowUpDays(value)).toBeNull();
    }
  });

  it("requires a string, because the form is the only source", () => {
    expect(normalizeFollowUpDays(14)).toBeNull();
  });
});
