import { describe, expect, it } from "vitest";
import { channelsFor, type ResolvedPreferences } from "@/lib/notifications/preferences";
import {
  appointmentCancelled,
  appointmentRescheduled,
  bookingConfirmed,
  paymentConfirmed,
  refundUpdate,
  reminder,
  visitThanks,
  type AppointmentMailContext,
} from "@/lib/notifications/templates";

function prefs(overrides: Partial<ResolvedPreferences> = {}): ResolvedPreferences {
  return {
    emailEnabled: true,
    smsEnabled: true,
    smsConsentAt: new Date("2026-10-01T00:00:00.000Z"),
    marketingOptIn: false,
    ...overrides,
  };
}

describe("channelsFor", () => {
  it("allows both channels for a fully opted-in patient with a phone", () => {
    expect(channelsFor(prefs(), { phone: "+919876543210" })).toEqual({ email: true, sms: true });
  });

  it("never texts a patient without recorded consent, even with a phone and the toggle on", () => {
    const withoutConsent = prefs({ smsConsentAt: null });
    expect(channelsFor(withoutConsent, { phone: "+919876543210" })).toEqual({
      email: true,
      sms: false,
    });
  });

  it("never texts a patient without a phone number", () => {
    expect(channelsFor(prefs(), { phone: null })).toEqual({ email: true, sms: false });
  });

  it("honours a disabled channel", () => {
    expect(channelsFor(prefs({ emailEnabled: false }), { phone: null })).toEqual({
      email: false,
      sms: false,
    });
    expect(channelsFor(prefs({ smsEnabled: false }), { phone: "+919876543210" })).toEqual({
      email: true,
      sms: false,
    });
  });
});

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
  // The settled payment behind this visit; the receipt link needs it.
  paymentId: 38,
  // Deliberately sensitive: if any template quotes this, the PHI rule is broken.
  reason: "diabetes follow-up, blood sugar high",
  fee: "600.00",
  currency: "INR",
};

const contents = [
  bookingConfirmed(ctx, { online: true }),
  paymentConfirmed(ctx),
  appointmentCancelled(ctx, {
    cancelledBy: "clinic",
    refundLine: "\nA refund of ₹600 is being processed.",
  }),
  appointmentRescheduled(ctx, { previousDate: "2026-11-01", previousTime: "09:00" }),
  reminder(ctx, { kind: "24h" }),
  reminder(ctx, { kind: "1h" }),
  refundUpdate(ctx, { stage: "initiated", amount: "600.00", currency: "INR" }),
  refundUpdate(ctx, { stage: "completed", amount: "600.00", currency: "INR" }),
  refundUpdate(ctx, { stage: "failed", amount: "600.00", currency: "INR" }),
  visitThanks(ctx, { hasAftercare: true }),
];

describe("templates", () => {
  it("never quote the patient's reason — it is medical content", () => {
    for (const content of contents) {
      expect(content.text).not.toContain(ctx.reason ?? "");
      expect(content.subject).not.toContain(ctx.reason ?? "");
      // The HTML rendering carries the same rule: escaping the reason would
      // still be a leak, so the content itself must never reach the markup.
      expect(content.html).not.toContain(ctx.reason ?? "");
      if (content.sms) expect(content.sms).not.toContain(ctx.reason ?? "");
    }
  });

  it("always brand SMS and name the doctor in email, so a message is self-explanatory", () => {
    for (const content of contents) {
      expect(content.text).toContain("Rao");
      expect(content.html).toContain("Rao");
      if (content.sms) {
        expect(content.sms.startsWith("Medrella:")).toBe(true);
        expect(content.sms.length).toBeGreaterThan(20);
      }
    }
  });

  it("renders every email as a complete, linked HTML document", () => {
    for (const content of contents) {
      expect(content.html.startsWith("<!doctype html>")).toBe(true);
      // Every mail offers the patient a next step back into the app.
      expect(content.html).toContain("/dashboard/patient");
    }
  });

  it("sends a settled payment straight to its receipt", () => {
    expect(paymentConfirmed(ctx).html).toContain("/dashboard/patient/receipts/38");
  });

  it("keep every SMS short enough to read in one glance", () => {
    for (const content of contents) {
      if (content.sms) expect(content.sms.length).toBeLessThanOrEqual(320);
    }
  });
});
