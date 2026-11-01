import { describe, expect, it } from "vitest";
import { describeCancellation } from "@/lib/cancel-preview";

// Fixed instant: clinic time is UTC+05:30, so 06:00Z is 11:30 IST.
const now = new Date("2026-11-01T06:00:00.000Z");

function preview(overrides: Partial<Parameters<typeof describeCancellation>[0]> = {}) {
  return describeCancellation({
    paymentStatus: "succeeded",
    paymentProvider: "razorpay",
    amount: "500.00",
    date: "2026-11-03",
    time: "10:00",
    now,
    ...overrides,
  });
}

describe("describeCancellation — what the confirm dialog promises", () => {
  it("promises the full fee more than 24 hours out", () => {
    const result = preview();
    expect(result.percentage).toBe(100);
    expect(result.headline).toContain("Full refund");
    expect(result.headline).toContain("₹500");
  });

  it("promises half within 24 hours", () => {
    const result = preview({ date: "2026-11-01", time: "20:00" });
    expect(result.percentage).toBe(50);
    expect(result.headline).toContain("50% refund");
    expect(result.headline).toContain("₹250");
  });

  it("promises nothing within 2 hours", () => {
    const result = preview({ date: "2026-11-01", time: "12:00" });
    expect(result.percentage).toBe(0);
    expect(result.headline).toBe("No refund");
  });

  it("always refunds in full when the clinic cancels", () => {
    const result = preview({ date: "2026-11-01", time: "12:00", cancelledBy: "clinic" });
    expect(result.percentage).toBe(100);
    expect(result.detail).toContain("clinic");
  });

  it("says there is nothing to refund when no money was captured", () => {
    expect(preview({ paymentStatus: "pending", paymentProvider: "razorpay" }).headline).toBe(
      "No payment captured",
    );
    expect(preview({ paymentStatus: null, paymentProvider: "manual" }).headline).toBe(
      "Nothing to refund",
    );
  });

  it("recognises an already-refunded visit", () => {
    expect(preview({ paymentStatus: "refunded" }).headline).toContain("Already refunded");
  });

  it("never states money is returned for an uncaptured payment", () => {
    for (const status of ["pending", "failed", null]) {
      const result = preview({ paymentStatus: status, paymentProvider: "razorpay" });
      expect(result.percentage).toBeNull();
      expect(result.headline.toLowerCase()).not.toContain("refund —");
    }
  });
});
