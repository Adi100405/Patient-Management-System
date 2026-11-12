import { describe, expect, it } from "vitest";
import {
  appointmentWindowChanged,
  type AppointmentMailContext,
} from "@/lib/notifications/templates";

/** A stream visit whose window was edited: booked at the start, end moved. */
const streamCtx: AppointmentMailContext = {
  appointmentId: 51,
  patientName: "Aarav Mehta",
  patientEmail: "aarav@example.com",
  patientPhone: "+919876543210",
  patientUserId: 7,
  doctorId: 3,
  doctorName: "Kavita Rao",
  specialization: "Cardiology",
  date: "2026-11-12",
  time: "16:00",
  schedulingType: "stream",
  visitEndTime: "19:00",
  // Deliberately sensitive: if any rendering quotes this, the PHI rule is broken.
  reason: "diabetes follow-up, blood sugar high",
  fee: "600.00",
  currency: "INR",
  paymentId: null,
};

const content = appointmentWindowChanged(streamCtx, { previousEnd: "18:00" });

describe("appointmentWindowChanged — a stream window's end moved under a booking", () => {
  it("carries both ranges, sharing the unchanged start", () => {
    expect(content.text).toContain("New window: Thu, 12 Nov at 4:00 PM – 7:00 PM");
    expect(content.text).toContain("Previous window: Thu, 12 Nov at 4:00 PM – 6:00 PM");
    expect(content.subject).toContain("Thu, 12 Nov");
  });

  it("tells the patient their start and queue place did not move", () => {
    expect(content.text).toContain("place in the queue are unchanged");
    expect(content.html).toContain("place in the queue are unchanged");
  });

  it("renders a complete HTML email that points back at the dashboard", () => {
    expect(content.html.startsWith("<!doctype html>")).toBe(true);
    expect(content.html).toContain("4:00 PM – 6:00 PM");
    expect(content.html).toContain("4:00 PM – 7:00 PM");
    expect(content.html).toContain("/dashboard/patient");
  });

  it("brands the SMS, names the doctor and stays short", () => {
    expect(content.sms).toBeDefined();
    expect(content.sms!.startsWith("Medrella:")).toBe(true);
    expect(content.sms).toContain("Rao");
    expect(content.sms).toContain("4:00 PM – 7:00 PM");
    expect(content.sms).toContain("4:00 PM – 6:00 PM");
    expect(content.sms!.length).toBeLessThan(220);
  });

  it("never quotes the patient's reason — it is medical content", () => {
    expect(content.text).not.toContain(streamCtx.reason);
    expect(content.html).not.toContain(streamCtx.reason);
    expect(content.sms!).not.toContain(streamCtx.reason);
  });
});
