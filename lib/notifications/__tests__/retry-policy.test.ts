import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, backoffFor, nextAttemptAt } from "@/lib/notifications/retry-policy";

describe("retry policy", () => {
  it("backs off exponentially and caps the delay", () => {
    const delays = Array.from({ length: MAX_ATTEMPTS + 2 }, (_, index) => backoffFor(index + 1));

    expect(delays[0]).toBe(60_000);
    expect(delays[1]).toBe(5 * 60_000);
    expect(delays[2]).toBe(15 * 60_000);
    expect(delays[3]).toBe(60 * 60_000);
    expect(delays[4]).toBe(6 * 60 * 60_000);
    // Beyond the table the last delay is reused, so a stale attempt count can
    // never produce an unbounded wait.
    expect(delays[MAX_ATTEMPTS + 1]).toBe(6 * 60 * 60_000);
  });

  it("treats a missing attempt count as the first attempt", () => {
    expect(backoffFor(0)).toBe(60_000);
    expect(backoffFor(-3)).toBe(60_000);
  });

  it("returns a new date, never mutating the input", () => {
    const now = new Date("2026-10-30T10:00:00.000Z");
    const retryAt = nextAttemptAt(now, 2);

    expect(retryAt.toISOString()).toBe("2026-10-30T10:05:00.000Z");
    expect(now.toISOString()).toBe("2026-10-30T10:00:00.000Z");
  });
});
