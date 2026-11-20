import { describe, expect, it } from "vitest";
import {
  buildQueue,
  checkInOpensAt,
  checkInWindow,
  formatClinicTime,
  formatToken,
  positionLabel,
  type QueueRow,
} from "@/lib/queue";

/** A row as the queue sees it, with sensible defaults for the parts a test does not care about. */
function row(overrides: Partial<QueueRow> & { id: number }): QueueRow {
  return {
    status: "booked",
    appointmentTime: "10:00",
    checkedInAt: null,
    tokenNumber: null,
    servingStartedAt: null,
    ...overrides,
  };
}

describe("buildQueue — who is waiting, and in what order", () => {
  it("puts nobody anywhere when the day is empty", () => {
    const view = buildQueue([]);
    expect(view.serving).toBeNull();
    expect(view.waiting).toHaveLength(0);
    expect(view.notCheckedIn).toHaveLength(0);
    expect(view.done).toHaveLength(0);
  });

  it("orders waiting patients by the moment they checked in", () => {
    const view = buildQueue([
      row({ id: 1, checkedInAt: "2026-11-16T05:00:00.000Z", tokenNumber: 2 }),
      row({ id: 2, checkedInAt: "2026-11-16T04:30:00.000Z", tokenNumber: 1 }),
    ]);

    expect(view.waiting.map((entry) => entry.id)).toEqual([2, 1]);
    expect(view.waiting.map((entry) => entry.position)).toEqual([1, 2]);
  });

  it("breaks a tie on the appointment id, so the order never wobbles", () => {
    const view = buildQueue([
      row({ id: 9, checkedInAt: "2026-11-16T05:00:00.000Z" }),
      row({ id: 4, checkedInAt: "2026-11-16T05:00:00.000Z" }),
    ]);

    expect(view.waiting.map((entry) => entry.id)).toEqual([4, 9]);
  });

  it("keeps the patient in the room out of the line", () => {
    const view = buildQueue([
      row({
        id: 1,
        checkedInAt: "2026-11-16T04:30:00.000Z",
        servingStartedAt: "2026-11-16T05:00:00.000Z",
        tokenNumber: 1,
      }),
      row({ id: 2, checkedInAt: "2026-11-16T04:40:00.000Z", tokenNumber: 2 }),
    ]);

    expect(view.serving?.id).toBe(1);
    expect(view.waiting.map((entry) => entry.id)).toEqual([2]);
    expect(view.waiting[0]?.position).toBe(1);
  });

  it("counts the people who have not arrived as not checked in", () => {
    const view = buildQueue([
      row({ id: 1, appointmentTime: "09:00" }),
      row({ id: 2, appointmentTime: "11:00" }),
    ]);

    expect(view.notCheckedIn.map((entry) => entry.id)).toEqual([1, 2]);
    expect(view.waiting).toHaveLength(0);
  });

  it("closes the gap when a patient cancels: positions are worked out, not stored", () => {
    const before = buildQueue([
      row({ id: 1, checkedInAt: "2026-11-16T04:30:00.000Z" }),
      row({ id: 2, checkedInAt: "2026-11-16T04:40:00.000Z" }),
      row({ id: 3, checkedInAt: "2026-11-16T04:50:00.000Z" }),
    ]);
    expect(before.waiting.map((entry) => entry.position)).toEqual([1, 2, 3]);

    const after = buildQueue([
      row({ id: 1, checkedInAt: "2026-11-16T04:30:00.000Z" }),
      row({ id: 2, status: "cancelled", checkedInAt: "2026-11-16T04:40:00.000Z" }),
      row({ id: 3, checkedInAt: "2026-11-16T04:50:00.000Z" }),
    ]);
    expect(after.waiting.map((entry) => entry.id)).toEqual([1, 3]);
    expect(after.waiting.map((entry) => entry.position)).toEqual([1, 2]);
    expect(after.done.map((entry) => entry.id)).toEqual([2]);
  });

  it("closes the gap when a patient does not arrive", () => {
    const view = buildQueue([
      row({ id: 1, checkedInAt: "2026-11-16T04:30:00.000Z" }),
      row({ id: 2, status: "no_show", checkedInAt: "2026-11-16T04:40:00.000Z" }),
    ]);

    expect(view.waiting.map((entry) => entry.id)).toEqual([1]);
    expect(view.waiting[0]?.position).toBe(1);
    expect(view.done.map((entry) => entry.id)).toEqual([2]);
  });

  it("leaves a displaced visit out of the queue: it is waiting for a new time", () => {
    const view = buildQueue([
      row({ id: 1, status: "needs_rebooking", appointmentTime: "10:00" }),
    ]);

    expect(view.waiting).toHaveLength(0);
    expect(view.notCheckedIn).toHaveLength(0);
    expect(view.done).toHaveLength(0);
  });

  it("keeps the token with the patient it was given to", () => {
    const view = buildQueue([
      row({ id: 1, checkedInAt: "2026-11-16T04:30:00.000Z", tokenNumber: 7 }),
    ]);

    expect(view.waiting[0]?.token).toBe("T-07");
  });
});

describe("formatToken — the number on the slip", () => {
  it("pads to two digits", () => {
    expect(formatToken(7)).toBe("T-07");
    expect(formatToken(42)).toBe("T-42");
  });

  it("has nothing to say about a visit with no token", () => {
    expect(formatToken(null)).toBeNull();
  });
});

describe("positionLabel — how a place in line reads", () => {
  it("calls the first person next", () => {
    expect(positionLabel(1)).toBe("You're next");
  });

  it("counts the rest", () => {
    expect(positionLabel(3)).toBe("Position 3");
  });

  it("has nothing to say about somebody who is not waiting", () => {
    expect(positionLabel(null)).toBeNull();
  });
});

describe("checkInWindow — when the desk may check a patient in", () => {
  // 2026-11-16 08:30 in clinic time (IST is UTC+05:30).
  const halfEight = new Date("2026-11-16T03:00:00.000Z");

  it("is closed for a visit that is already behind the clinic", () => {
    expect(checkInWindow("2026-11-15", "10:00", halfEight).state).toBe("closed");
  });

  it("is closed for a visit days away", () => {
    expect(checkInWindow("2026-11-20", "10:00", halfEight).state).toBe("future");
  });

  it("opens an hour before the visit", () => {
    const window = checkInWindow("2026-11-16", "10:30", halfEight);
    expect(window.state).toBe("before");
    expect(window.state === "before" && window.opensAt).toBe("9:30 AM");
  });

  it("is open once the hour is up", () => {
    expect(checkInWindow("2026-11-16", "10:30", new Date("2026-11-16T05:00:00.000Z")).state).toBe(
      "open",
    );
  });

  it("stays open for the rest of the day", () => {
    expect(checkInWindow("2026-11-16", "10:30", new Date("2026-11-16T12:00:00.000Z")).state).toBe(
      "open",
    );
  });

  it("never opens before the clinic day itself", () => {
    // A visit booked for 00:30 opens at midnight, not the evening before.
    expect(checkInOpensAt("2026-11-16", "00:30").toISOString()).toBe("2026-11-15T18:30:00.000Z");
    expect(checkInWindow("2026-11-16", "00:30", halfEight).state).toBe("open");
  });
});

describe("formatClinicTime — a moment in clinic time", () => {
  it("reads the clock as the clinic does", () => {
    expect(formatClinicTime(new Date("2026-11-16T05:12:00.000Z"))).toBe("10:42 AM");
  });
});
