import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_GRACE_HOURS,
  THANKS_WINDOW_HOURS,
  followUpDue,
  thanksDue,
} from "@/lib/notifications/care";
import { followUpPrompt, visitThanks } from "@/lib/notifications/templates";
import type { AppointmentMailContext } from "@/lib/notifications/templates";
import { deliveredTo } from "@/lib/notifications/events";
import { normalizeAftercare, normalizeFollowUpDays } from "@/lib/visit-notes";

const ctx: AppointmentMailContext = {
  appointmentId: 42,
  patientName: "Aarav Mehta",
  patientEmail: "aarav@example.com",
  patientPhone: "+919876543210",
  patientUserId: 7,
  doctorId: 3,
  doctorName: "Kavita Rao",
  specialization: "Cardiology",
  date: "2026-11-02",
  time: "10:30",
  paymentId: 38,
  // Deliberately sensitive: if a care template quotes this, the PHI rule is broken.
  reason: "diabetes follow-up, blood sugar high",
  fee: "600.00",
  currency: "INR",
};

describe("care follow-up windows", () => {
  it("thanks a patient only after the visit and not long after it", () => {
    expect(thanksDue(-1)).toBe(false); // the visit has not happened yet
    expect(thanksDue(0)).toBe(true);
    expect(thanksDue(THANKS_WINDOW_HOURS)).toBe(true);
    expect(thanksDue(THANKS_WINDOW_HOURS + 0.01)).toBe(false);
  });

  it("prompts a follow-up once the advised interval has passed, with a grace window", () => {
    const days = 14;
    const dueAt = days * 24;
    expect(followUpDue(dueAt - 1, days)).toBe(false);
    expect(followUpDue(dueAt, days)).toBe(true);
    expect(followUpDue(dueAt + FOLLOW_UP_GRACE_HOURS, days)).toBe(true);
    expect(followUpDue(dueAt + FOLLOW_UP_GRACE_HOURS + 0.01, days)).toBe(false);
  });
});

describe("aftercare parsing", () => {
  it("stores a trimmed note and nothing for a blank one", () => {
    expect(normalizeAftercare("  Rest and hydrate.  ")).toBe("Rest and hydrate.");
    expect(normalizeAftercare("   ")).toBeNull();
    expect(normalizeAftercare(undefined)).toBeNull();
    expect(normalizeAftercare(42)).toBeNull();
  });

  it("keeps a follow-up interval only within 1..365 whole days", () => {
    expect(normalizeFollowUpDays("14")).toBe(14);
    expect(normalizeFollowUpDays(" 7 ")).toBe(7);
    expect(normalizeFollowUpDays("0")).toBeNull();
    expect(normalizeFollowUpDays("366")).toBeNull();
    expect(normalizeFollowUpDays("2.5")).toBeNull();
    expect(normalizeFollowUpDays("-3")).toBeNull();
    expect(normalizeFollowUpDays("")).toBeNull();
    expect(normalizeFollowUpDays(undefined)).toBeNull();
  });
});

describe("deliveredTo — what the sweep records", () => {
  const delivered = { delivered: true, id: 1, duplicate: false };
  const failed = { delivered: false, id: 1, duplicate: false };

  it("records the email when email landed", () => {
    expect(deliveredTo(ctx, { email: delivered, mobile: null })).toBe(ctx.patientEmail);
  });

  it("records the phone when only mobile landed, e.g. email switched off", () => {
    expect(deliveredTo(ctx, { email: null, mobile: delivered })).toBe(ctx.patientPhone);
  });

  it("records nothing when neither landed, so the sweep retries", () => {
    expect(deliveredTo(ctx, { email: failed, mobile: failed })).toBeNull();
    expect(deliveredTo(ctx, { email: null, mobile: null })).toBeNull();
  });

  it("does not claim a mobile delivery with no phone on file", () => {
    expect(deliveredTo({ ...ctx, patientPhone: null }, { email: null, mobile: delivered })).toBeNull();
  });
});

describe("care templates", () => {
  it("never quote the patient's reason — it is medical content", () => {
    for (const content of [
      visitThanks(ctx, { hasAftercare: true }),
      visitThanks(ctx, { hasAftercare: false }),
      followUpPrompt(ctx, { days: 14 }),
    ]) {
      expect(content.text).not.toContain(ctx.reason ?? "");
      expect(content.subject).not.toContain(ctx.reason ?? "");
      expect(content.html).not.toContain(ctx.reason ?? "");
      if (content.sms) expect(content.sms).not.toContain(ctx.reason ?? "");
    }
  });

  it("sends the follow-up straight to the doctor's booking page", () => {
    const content = followUpPrompt(ctx, { days: 14 });
    expect(content.html).toContain("/doctors/3");
    expect(content.html.startsWith("<!doctype html>")).toBe(true);
    expect(content.sms?.startsWith("Medrella:")).toBe(true);
  });

  it("points a thank-you with aftercare at the dashboard, never at the note", () => {
    const withNote = visitThanks(ctx, { hasAftercare: true });
    expect(withNote.html).toContain("/dashboard/patient");
    expect(withNote.text).toContain("aftercare");
  });
});
