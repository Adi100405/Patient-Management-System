import { describe, expect, it } from "vitest";
import {
  blockAppliesOn,
  blocksConflict,
  offersFor,
  openDates,
  positionsFor,
  seatFor,
  streamSpacing,
  visitWhenLabel,
  type ScheduleBlock,
} from "@/lib/schedule";

function wave(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    id: 1,
    schedulingType: "wave",
    dayOfWeek: 1,
    dates: [],
    startTime: "10:00",
    endTime: "12:00",
    slotMinutes: 30,
    capacity: 3,
    ...overrides,
  };
}

function stream(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    id: 1,
    schedulingType: "stream",
    dayOfWeek: 1,
    dates: [],
    startTime: "10:00",
    endTime: "12:00",
    slotMinutes: streamSpacing("10:00", "12:00", 5),
    capacity: 5,
    ...overrides,
  };
}

describe("positionsFor — wave blocks", () => {
  it("starts a slot at the window start and strides by the visit length", () => {
    const positions = positionsFor(wave({ slotMinutes: 30 }));

    expect(positions.map((p) => p.time)).toEqual(["10:00", "10:30", "11:00", "11:30"]);
  });

  it("gives every wave position the block's capacity in seats", () => {
    const positions = positionsFor(wave({ capacity: 3 }));

    expect(positions.map((p) => p.seats)).toEqual([3, 3, 3, 3]);
  });

  it("holds one patient per slot when the capacity is one", () => {
    const positions = positionsFor(wave({ capacity: 1 }));

    expect(positions.map((p) => p.seats)).toEqual([1, 1, 1, 1]);
  });

  it("drops a slot that would not finish before the window closes", () => {
    const positions = positionsFor(wave({ startTime: "10:00", endTime: "11:20", slotMinutes: 30 }));

    expect(positions.map((p) => p.time)).toEqual(["10:00", "10:30"]);
  });
});

describe("streamSpacing — the publish-time spacing of a stream window", () => {
  it("divides the window by the capacity", () => {
    expect(streamSpacing("10:00", "12:00", 5)).toBe(24);
  });

  it("rounds to whole minutes when the window does not divide evenly", () => {
    expect(streamSpacing("10:00", "11:40", 3)).toBe(33);
  });

  it("never returns less than one minute", () => {
    expect(streamSpacing("10:00", "10:01", 50)).toBe(1);
  });
});

describe("seatFor — which seat a new patient takes", () => {
  it("takes seat one when the slot is empty", () => {
    expect(seatFor([], 3)).toBe(1);
  });

  it("takes the next free seat", () => {
    expect(seatFor([1], 3)).toBe(2);
  });

  it("takes the lowest free seat when an earlier one was released", () => {
    expect(seatFor([1, 3], 3)).toBe(2);
  });

  it("returns nothing when every seat is taken", () => {
    expect(seatFor([1, 2, 3], 3)).toBeNull();
  });

  it("returns nothing when the slot has a single seat and it is taken", () => {
    expect(seatFor([1], 1)).toBeNull();
  });
});

describe("blockAppliesOn — which dates a block is open on", () => {
  it("opens a weekly block on its weekday", () => {
    expect(blockAppliesOn(wave({ dayOfWeek: 1 }), "2026-11-02")).toBe(true);
  });

  it("closes a weekly block on every other weekday", () => {
    expect(blockAppliesOn(wave({ dayOfWeek: 1 }), "2026-11-03")).toBe(false);
  });

  it("opens a dated block on a listed date", () => {
    const block = wave({ dayOfWeek: null, dates: ["2026-11-12", "2026-11-19"] });

    expect(blockAppliesOn(block, "2026-11-19")).toBe(true);
  });

  it("closes a dated block on a date it does not list", () => {
    const block = wave({ dayOfWeek: null, dates: ["2026-11-12", "2026-11-19"] });

    expect(blockAppliesOn(block, "2026-11-20")).toBe(false);
  });
});

describe("blocksConflict — two blocks may not cover the same clock time on the same date", () => {
  it("rejects two weekly blocks on the same weekday", () => {
    expect(blocksConflict(wave({ dayOfWeek: 1 }), wave({ dayOfWeek: 1, startTime: "11:00" }))).toBe(
      true,
    );
  });

  it("allows two weekly blocks on different weekdays", () => {
    expect(blocksConflict(wave({ dayOfWeek: 1 }), wave({ dayOfWeek: 2 }))).toBe(false);
  });

  it("allows two weekly blocks that do not overlap in time", () => {
    expect(blocksConflict(wave({ startTime: "09:00", endTime: "10:00" }), wave({ startTime: "11:00" }))).toBe(
      false,
    );
  });

  it("rejects a dated block that lands on a weekly block's weekday", () => {
    const dated = wave({ dayOfWeek: null, dates: ["2026-11-02"] });

    expect(blocksConflict(wave({ dayOfWeek: 1 }), dated)).toBe(true);
  });

  it("allows a dated block on a weekday the weekly block does not cover", () => {
    const dated = wave({ dayOfWeek: null, dates: ["2026-11-03"] });

    expect(blocksConflict(wave({ dayOfWeek: 1 }), dated)).toBe(false);
  });

  it("rejects two dated blocks that share a date", () => {
    const a = wave({ dayOfWeek: null, dates: ["2026-11-12", "2026-11-19"] });
    const b = wave({ dayOfWeek: null, dates: ["2026-11-19"] });

    expect(blocksConflict(a, b)).toBe(true);
  });

  it("allows two dated blocks on different dates", () => {
    const a = wave({ dayOfWeek: null, dates: ["2026-11-12"] });
    const b = wave({ dayOfWeek: null, dates: ["2026-11-19"] });

    expect(blocksConflict(a, b)).toBe(false);
  });
});

describe("offersFor — what a patient can book on one date", () => {
  const monday = "2026-11-02";

  it("offers the positions of a block that applies on that date", () => {
    const offers = offersFor({
      blocks: [wave({ id: 7 })],
      date: monday,
      takenSeats: new Map(),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers.map((offer) => offer.time)).toEqual(["10:00", "10:30", "11:00", "11:30"]);
  });

  it("offers nothing for a block that does not apply on that date", () => {
    const offers = offersFor({
      blocks: [wave({ id: 7, dayOfWeek: 2 })],
      date: monday,
      takenSeats: new Map(),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers).toEqual([]);
  });

  it("counts the seats already taken at a time", () => {
    const offers = offersFor({
      blocks: [wave({ id: 7, capacity: 3 })],
      date: monday,
      takenSeats: new Map([["10:00", 2]]),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers[0]).toMatchObject({ time: "10:00", seats: 3, taken: 2, free: 1 });
  });

  it("leaves no free seat once every seat is taken", () => {
    const offers = offersFor({
      blocks: [wave({ id: 7, capacity: 3 })],
      date: monday,
      takenSeats: new Map([["10:00", 3]]),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers[0]).toMatchObject({ time: "10:00", taken: 3, free: 0 });
  });

  it("leaves no free seat when more patients booked than the capacity allows", () => {
    const offers = offersFor({
      blocks: [wave({ id: 7, capacity: 3 })],
      date: monday,
      takenSeats: new Map([["10:00", 5]]),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers[0]?.free).toBe(0);
  });

  it("drops a position that has already started today", () => {
    const offers = offersFor({
      blocks: [wave({ id: 7 })],
      date: "2026-11-02",
      takenSeats: new Map(),
      now: { date: "2026-11-02", minutes: 630 },
    });

    expect(offers.map((offer) => offer.time)).toEqual(["11:00", "11:30"]);
  });

  it("keeps a position that has not started yet today", () => {
    const offers = offersFor({
      blocks: [wave({ id: 7 })],
      date: "2026-11-02",
      takenSeats: new Map(),
      now: { date: "2026-11-02", minutes: 600 },
    });

    expect(offers.map((offer) => offer.time)).toEqual(["10:30", "11:00", "11:30"]);
  });

  it("offers a dated block only on one of its dates", () => {
    const block = wave({ id: 7, dayOfWeek: null, dates: ["2026-11-09"] });

    expect(
      offersFor({
        blocks: [block],
        date: monday,
        takenSeats: new Map(),
        now: { date: "2026-11-01", minutes: 0 },
      }),
    ).toEqual([]);

    expect(
      offersFor({
        blocks: [block],
        date: "2026-11-09",
        takenSeats: new Map(),
        now: { date: "2026-11-01", minutes: 0 },
      }),
    ).toHaveLength(4);
  });

  it("closes once the window's start has passed", () => {
    const offers = offersFor({
      blocks: [stream({ id: 3, capacity: 5 })],
      date: "2026-11-02",
      takenSeats: new Map(),
      now: { date: "2026-11-02", minutes: 600 },
    });

    expect(offers).toEqual([]);
  });

  it("offers a stream window once with its full start–end span, not per-position times", () => {
    const offers = offersFor({
      blocks: [stream({ id: 3, capacity: 5 })],
      date: monday,
      takenSeats: new Map(),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers.map((offer) => [offer.time, offer.endTime])).toEqual([["10:00", "12:00"]]);
  });

  it("carries the block's identity and window span onto the offer", () => {
    const offers = offersFor({
      blocks: [stream({ id: 3, capacity: 2, slotMinutes: 60 })],
      date: monday,
      takenSeats: new Map(),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers[0]).toMatchObject({
      time: "10:00",
      endTime: "12:00",
      availabilityId: 3,
      schedulingType: "stream",
      seats: 2,
    });
  });

  it("counts the patients already booked into the window, tallied at its start", () => {
    const offers = offersFor({
      blocks: [stream({ id: 3, capacity: 5 })],
      date: monday,
      takenSeats: new Map([["10:00", 2]]),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers[0]).toMatchObject({
      time: "10:00",
      endTime: "12:00",
      seats: 5,
      taken: 2,
      free: 3,
    });
  });

  it("leaves nothing free once the window's capacity is fully booked", () => {
    const offers = offersFor({
      blocks: [stream({ id: 3, capacity: 5 })],
      date: monday,
      takenSeats: new Map([["10:00", 5]]),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(offers[0]?.free).toBe(0);
  });

  it("offers a dated stream window only on one of its dates", () => {
    const block = stream({ id: 5, dayOfWeek: null, dates: ["2026-11-09"] });

    expect(
      offersFor({
        blocks: [block],
        date: monday,
        takenSeats: new Map(),
        now: { date: "2026-11-01", minutes: 0 },
      }),
    ).toEqual([]);

    const windowOffers = offersFor({
      blocks: [block],
      date: "2026-11-09",
      takenSeats: new Map(),
      now: { date: "2026-11-01", minutes: 0 },
    });

    expect(windowOffers.map((offer) => [offer.time, offer.endTime])).toEqual([["10:00", "12:00"]]);
  });
});

describe("openDates — the dates a patient may book", () => {
  const candidates = [
    { date: "2026-11-02", dayOfWeek: 1 },
    { date: "2026-11-03", dayOfWeek: 2 },
    { date: "2026-11-12", dayOfWeek: 4 },
  ];

  it("keeps the weekday a weekly block covers", () => {
    const open = openDates([wave({ dayOfWeek: 1 })], candidates);

    expect(open.map((day) => day.date)).toEqual(["2026-11-02"]);
  });

  it("keeps the explicit dates a dated block opens", () => {
    const open = openDates(
      [wave({ dayOfWeek: null, dates: ["2026-11-12"] })],
      candidates,
    );

    expect(open.map((day) => day.date)).toEqual(["2026-11-12"]);
  });

  it("keeps a date no block covers out of the list", () => {
    const open = openDates(
      [wave({ dayOfWeek: 1 }), wave({ dayOfWeek: null, dates: ["2026-11-12"] })],
      candidates,
    );

    expect(open.map((day) => day.date)).toEqual(["2026-11-02", "2026-11-12"]);
  });

  it("keeps nothing when there are no blocks", () => {
    expect(openDates([], candidates)).toEqual([]);
  });
});

describe("visitWhenLabel — how a visit reads in an appointment list", () => {
  it("reads a stream visit as one start–end range", () => {
    expect(
      visitWhenLabel({ schedulingType: "stream", time: "10:00", windowEnd: "12:00" }),
    ).toBe("10:00 AM – 12:00 PM");
  });

  it("reads a wave visit as its own start time", () => {
    expect(visitWhenLabel({ schedulingType: "wave", time: "10:30" })).toBe("10:30 AM");
  });

  it("falls back to the start time when a stream row has no window end", () => {
    expect(visitWhenLabel({ schedulingType: "stream", time: "10:00" })).toBe("10:00 AM");
  });
});
