import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clinicClock,
  clinicNow,
  dayOfWeekFor,
  hoursUntilSlot,
  slotArrived,
  toMinutes,
  toTime,
  upcomingDays,
} from "@/lib/slots";

afterEach(() => {
  vi.useRealTimers();
});

describe("toMinutes — a wall-clock time as minutes since midnight", () => {
  it("reads the hour and the minute", () => {
    expect(toMinutes("09:30")).toBe(570);
  });

  it("reads midnight", () => {
    expect(toMinutes("00:00")).toBe(0);
  });

  it("reads the last minute of the day", () => {
    expect(toMinutes("23:59")).toBe(1439);
  });
});

describe("toTime — minutes since midnight as a wall-clock time", () => {
  it("pads the hour and the minute", () => {
    expect(toTime(570)).toBe("09:30");
  });

  it("pads midnight", () => {
    expect(toTime(0)).toBe("00:00");
  });
});

describe("dayOfWeekFor — the weekday a date falls on", () => {
  it("reads Wednesday for 2026-11-04", () => {
    expect(dayOfWeekFor("2026-11-04")).toBe(3);
  });

  it("reads Sunday for 2026-11-01", () => {
    expect(dayOfWeekFor("2026-11-01")).toBe(0);
  });

  it("reads the same weekday regardless of the server's own time zone", () => {
    expect(dayOfWeekFor("2026-01-01")).toBe(4);
  });
});

describe("clinicNow — the clinic wall clock", () => {
  it("resolves the date and the clock in clinic time, not UTC", () => {
    const now = clinicNow(new Date("2026-11-04T06:00:00.000Z"));

    expect(now.date).toBe("2026-11-04");
    expect(now.minutes).toBe(690);
  });

  it("reads the clock in the same clinic time", () => {
    expect(clinicClock(new Date("2026-11-04T06:00:00.000Z"))).toBe("11:30");
  });
});

describe("slotArrived — whether a visit has started", () => {
  const now = new Date("2026-11-04T06:00:00.000Z");

  it("is true for a slot earlier today", () => {
    expect(slotArrived("2026-11-04", "10:00", now)).toBe(true);
  });

  it("is false for a slot later today", () => {
    expect(slotArrived("2026-11-04", "14:00", now)).toBe(false);
  });

  it("is true for any slot on an earlier date", () => {
    expect(slotArrived("2026-11-03", "23:00", now)).toBe(true);
  });
});

describe("hoursUntilSlot — time left before a visit", () => {
  it("counts the hours from now until the slot", () => {
    const now = new Date("2026-11-04T06:00:00.000Z");

    expect(hoursUntilSlot("2026-11-04", "14:00", now)).toBe(2.5);
  });

  it("goes negative once the slot has passed", () => {
    const now = new Date("2026-11-04T06:00:00.000Z");

    expect(hoursUntilSlot("2026-11-04", "10:00", now)).toBe(-1.5);
  });
});

describe("upcomingDays — the next clinic days", () => {
  it("starts on today and runs for seven days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T06:00:00.000Z"));

    const days = upcomingDays();

    expect(days).toHaveLength(7);
    expect(days[0]?.date).toBe("2026-11-04");
    expect(days[0]?.isToday).toBe(true);
    expect(days[6]?.date).toBe("2026-11-10");
  });

  it("gives each day its weekday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T06:00:00.000Z"));

    const days = upcomingDays();

    expect(days[0]?.dayOfWeek).toBe(3);
    expect(days[1]?.dayOfWeek).toBe(4);
  });
});
