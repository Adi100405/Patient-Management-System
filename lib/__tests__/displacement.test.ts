import { describe, expect, it } from "vitest";
import {
  planDisplacement,
  queueOrder,
  queueRanks,
  type DisplacementBooking,
  type DisplacementInput,
} from "@/lib/displacement";
import { streamSpacing, type ScheduleBlock } from "@/lib/schedule";
import type { ClinicClock } from "@/lib/slots";

const FULL_DAY: ClinicClock = { date: "2026-11-04", minutes: 8 * 60 };

function wave(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    id: 1,
    schedulingType: "wave",
    dayOfWeek: null,
    dates: ["2026-11-04"],
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
    dayOfWeek: null,
    dates: ["2026-11-04"],
    startTime: "10:00",
    endTime: "12:00",
    slotMinutes: streamSpacing("10:00", "12:00", 3),
    capacity: 3,
    ...overrides,
  };
}

function booking(
  id: number,
  overrides: Partial<DisplacementBooking> = {},
): DisplacementBooking {
  return {
    id,
    availabilityId: 1,
    date: "2026-11-04",
    time: "10:00",
    seatNumber: id,
    queueSince: `2026-11-01T0${id}:00:00.000Z`,
    ...overrides,
  };
}

function plan(input: {
  candidate: ScheduleBlock;
  blocks?: readonly ScheduleBlock[];
  bookings: readonly DisplacementBooking[];
  now?: ClinicClock;
  horizonDays?: number;
}) {
  return planDisplacement({
    candidate: input.candidate,
    blocks: input.blocks ?? [wave({ id: input.candidate.id })],
    bookings: input.bookings,
    now: input.now ?? FULL_DAY,
    horizonDays: input.horizonDays,
  } satisfies DisplacementInput);
}

describe("queueOrder — who booked first", () => {
  it("orders by queue_since, not by seat number", () => {
    const ordered = queueOrder([
      booking(1, { seatNumber: 3, queueSince: "2026-11-01T10:00:00.000Z" }),
      booking(2, { seatNumber: 1, queueSince: "2026-11-01T08:00:00.000Z" }),
      booking(3, { seatNumber: 2, queueSince: "2026-11-01T09:00:00.000Z" }),
    ]);

    expect(ordered.map((row) => row.id)).toEqual([2, 3, 1]);
  });

  it("breaks an identical queue_since by appointment id", () => {
    const ordered = queueOrder([
      booking(9, { queueSince: "2026-11-01T09:00:00.000Z" }),
      booking(3, { queueSince: "2026-11-01T09:00:00.000Z" }),
    ]);

    expect(ordered.map((row) => row.id)).toEqual([3, 9]);
  });

  it("gives one-based ranks within a slot", () => {
    const ranks = queueRanks([
      booking(1, { queueSince: "2026-11-01T10:00:00.000Z" }),
      booking(2, { queueSince: "2026-11-01T08:00:00.000Z" }),
    ]);

    expect(ranks.get(2)).toBe(1);
    expect(ranks.get(1)).toBe(2);
  });
});

describe("planDisplacement — wave capacity shrink", () => {
  it("fills each date separately, so one day's bookings never displace another's", () => {
    const block = wave({
      id: 1,
      dates: ["2026-11-04", "2026-11-05"],
      endTime: "10:30",
      capacity: 2,
    });
    const result = plan({
      candidate: { ...block, capacity: 1 },
      blocks: [block],
      bookings: [
        booking(1, { availabilityId: 1, seatNumber: 1 }),
        booking(2, {
          availabilityId: 1,
          date: "2026-11-05",
          seatNumber: 1,
          queueSince: "2026-11-01T00:00:00.000Z",
        }),
      ],
    });

    expect(result.stayedCount).toBe(2);
    expect(result.placements.find((row) => row.appointmentId === 1)?.queueRank).toBe(1);
    expect(result.placements.find((row) => row.appointmentId === 2)?.queueRank).toBe(1);
    expect(result.hasChanges).toBe(false);
  });
  it("keeps the oldest bookings and moves the newest into remaining same-day capacity", () => {
    const result = plan({
      candidate: wave({ capacity: 2 }),
      bookings: [
        booking(1, { seatNumber: 1, queueSince: "2026-11-01T10:00:00.000Z" }),
        booking(2, { seatNumber: 2, queueSince: "2026-11-01T08:00:00.000Z" }),
        booking(3, { seatNumber: 3, queueSince: "2026-11-01T12:00:00.000Z" }),
      ],
    });

    expect(result.placements.find((row) => row.appointmentId === 2)?.outcome).toBe("stayed");
    expect(result.placements.find((row) => row.appointmentId === 1)?.outcome).toBe("stayed");
    expect(result.placements.find((row) => row.appointmentId === 3)).toMatchObject({
      outcome: "moved",
      reason: "capacity",
      to: { date: "2026-11-04", time: "10:30", seatNumber: 1, availabilityId: 1 },
    });
    expect(result.movedCount).toBe(1);
    expect(result.displacedCount).toBe(1);
    expect(result.hasChanges).toBe(true);
  });

  it("moves a visit whose wave position disappears", () => {
    const result = plan({
      candidate: wave({ endTime: "11:00", capacity: 2 }),
      bookings: [booking(1, { time: "11:30", seatNumber: 1 })],
    });

    expect(result.placements[0]).toMatchObject({
      outcome: "moved",
      reason: "slot_removed",
      to: { date: "2026-11-04", time: "10:00", seatNumber: 1, availabilityId: 1 },
    });
  });

  it("prefers same-day capacity before the next day", () => {
    const blocks = [
      wave({ id: 1, dates: ["2026-11-04", "2026-11-05"], endTime: "10:30", capacity: 2 }),
      wave({ id: 2, dates: ["2026-11-04"], startTime: "14:00", endTime: "14:30", capacity: 1 }),
    ];

    const result = plan({
      candidate: blocks[0]!,
      blocks,
      bookings: [
        booking(1, { availabilityId: 1, seatNumber: 1 }),
        booking(2, { availabilityId: 1, seatNumber: 2 }),
      ],
    });

    // Candidate capacity is still 2, so shrink it in the fixture above.
    const shrunk = plan({
      candidate: wave({ id: 1, dates: ["2026-11-04", "2026-11-05"], endTime: "10:30", capacity: 1 }),
      blocks,
      bookings: [
        booking(1, { availabilityId: 1, seatNumber: 1 }),
        booking(2, { availabilityId: 1, seatNumber: 2 }),
      ],
    });

    expect(result.stayedCount).toBe(2);
    expect(shrunk.placements.find((row) => row.appointmentId === 2)).toMatchObject({
      outcome: "moved",
      to: { date: "2026-11-04", time: "14:00", availabilityId: 2 },
    });
  });

  it("uses the next day when the original day has no free capacity", () => {
    const block = wave({ id: 1, dates: ["2026-11-04", "2026-11-05"], endTime: "10:30", capacity: 2 });
    const result = plan({
      candidate: { ...block, capacity: 1 },
      blocks: [block],
      bookings: [
        booking(1, { availabilityId: 1, seatNumber: 1 }),
        booking(2, { availabilityId: 1, seatNumber: 2 }),
      ],
    });

    expect(result.placements.find((row) => row.appointmentId === 2)).toMatchObject({
      outcome: "moved",
      to: { date: "2026-11-05", time: "10:00", availabilityId: 1 },
    });
  });

  it("parks a visit as needs_rebooking once the seven-day horizon is exhausted", () => {
    const block = wave({ id: 1, dates: ["2026-11-04"], endTime: "10:30", capacity: 2 });
    const result = plan({
      candidate: { ...block, capacity: 1 },
      blocks: [block],
      bookings: [
        booking(1, { availabilityId: 1, seatNumber: 1 }),
        booking(2, { availabilityId: 1, seatNumber: 2 }),
      ],
    });

    expect(result.placements.find((row) => row.appointmentId === 2)).toMatchObject({
      outcome: "needs_rebooking",
      reason: "capacity",
      to: null,
    });
    expect(result.needsRebookingCount).toBe(1);
  });

  it("still finds a slot exactly seven days later", () => {
    const block = wave({
      id: 1,
      dates: ["2026-11-04", "2026-11-11"],
      endTime: "10:30",
      capacity: 2,
    });
    const result = plan({
      candidate: { ...block, capacity: 1 },
      blocks: [block],
      bookings: [
        booking(1, { availabilityId: 1, seatNumber: 1 }),
        booking(2, { availabilityId: 1, seatNumber: 2 }),
      ],
    });

    expect(result.placements.find((row) => row.appointmentId === 2)).toMatchObject({
      outcome: "moved",
      to: { date: "2026-11-11", time: "10:00" },
    });
  });
});

describe("planDisplacement — closing a window", () => {
  it("displaces every not-started booking when end equals start", () => {
    const result = plan({
      candidate: wave({ startTime: "10:00", endTime: "10:00" }),
      bookings: [booking(1)],
    });

    expect(result.placements[0]).toMatchObject({
      outcome: "needs_rebooking",
      reason: "window_closed",
      to: null,
    });
    expect(result.displacedCount).toBe(1);
  });

  it("can move a closed window's patient into another same-day window", () => {
    const blocks = [
      wave({ id: 1, startTime: "10:00", endTime: "10:00" }),
      wave({ id: 2, startTime: "15:00", endTime: "16:00", capacity: 1 }),
    ];

    const result = plan({
      candidate: blocks[0]!,
      blocks,
      bookings: [booking(1, { availabilityId: 1 })],
    });

    expect(result.placements[0]).toMatchObject({
      outcome: "moved",
      reason: "window_closed",
      to: { date: "2026-11-04", time: "15:00", availabilityId: 2 },
    });
  });

  it("leaves an already-started visit where it is", () => {
    const result = plan({
      candidate: wave({ startTime: "10:00", endTime: "10:00" }),
      bookings: [
        booking(1, { time: "10:00" }),
        booking(2, { time: "11:00" }),
      ],
      now: { date: "2026-11-04", minutes: 10 * 60 + 30 },
    });

    expect(result.placements.find((row) => row.appointmentId === 1)).toMatchObject({
      outcome: "locked",
      reason: "started",
      to: { time: "10:00" },
    });
    expect(result.placements.find((row) => row.appointmentId === 2)).toMatchObject({
      outcome: "needs_rebooking",
      reason: "window_closed",
    });
    expect(result.lockedCount).toBe(1);
  });

  it("never falls back into a slot that has already started today", () => {
    const block = wave({
      id: 1,
      startTime: "09:00",
      endTime: "12:00",
      capacity: 1,
    });
    const result = plan({
      candidate: { ...block, endTime: "10:00" },
      blocks: [block],
      bookings: [
        booking(1, { time: "09:00" }),
        booking(2, { time: "11:00" }),
      ],
      now: { date: "2026-11-04", minutes: 10 * 60 + 30 },
    });

    expect(result.placements.find((row) => row.appointmentId === 1)?.outcome).toBe("locked");
    expect(result.placements.find((row) => row.appointmentId === 2)).toMatchObject({
      outcome: "needs_rebooking",
      reason: "slot_removed",
    });
  });
});

describe("planDisplacement — stream windows", () => {
  it("gives each date its own capacity", () => {
    const block = stream({
      id: 1,
      dates: ["2026-11-04", "2026-11-05"],
      capacity: 1,
    });
    const result = plan({
      candidate: { ...block, capacity: 1 },
      blocks: [block],
      bookings: [
        booking(1, { availabilityId: 1, seatNumber: 1 }),
        booking(2, {
          availabilityId: 1,
          date: "2026-11-05",
          seatNumber: 1,
          queueSince: "2026-11-01T00:00:00.000Z",
        }),
      ],
    });

    expect(result.stayedCount).toBe(2);
    expect(result.hasChanges).toBe(false);
  });
  it("retimes every live booking when the start moves", () => {
    const result = plan({
      candidate: stream({ startTime: "11:00" }),
      bookings: [
        booking(1, { seatNumber: 1 }),
        booking(2, { seatNumber: 2 }),
      ],
    });

    expect(result.retimedCount).toBe(2);
    expect(result.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appointmentId: 1,
          outcome: "retimed",
          reason: "start_moved",
          to: expect.objectContaining({ time: "11:00", seatNumber: 1, availabilityId: 1 }),
        }),
        expect.objectContaining({
          appointmentId: 2,
          outcome: "retimed",
          to: expect.objectContaining({ time: "11:00", seatNumber: 2 }),
        }),
      ]),
    );
  });

  it("keeps the oldest patients first when capacity shrinks", () => {
    const block = stream({ capacity: 2 });
    const result = plan({
      candidate: { ...block, capacity: 1 },
      blocks: [block],
      bookings: [
        booking(1, { queueSince: "2026-11-01T08:00:00.000Z" }),
        booking(2, { queueSince: "2026-11-01T09:00:00.000Z" }),
      ],
    });

    expect(result.placements.find((row) => row.appointmentId === 1)?.outcome).toBe("stayed");
    expect(result.placements.find((row) => row.appointmentId === 2)).toMatchObject({
      outcome: "needs_rebooking",
      reason: "capacity",
    });
  });

  it("does not move anyone when only the end changes", () => {
    const result = plan({
      candidate: stream({ endTime: "11:00" }),
      bookings: [booking(1), booking(2, { seatNumber: 2 })],
    });

    expect(result.stayedCount).toBe(2);
    expect(result.hasChanges).toBe(false);
  });

  it("locks a stream visit that had already started", () => {
    const result = plan({
      candidate: stream({ startTime: "11:00" }),
      bookings: [booking(1)],
      now: { date: "2026-11-04", minutes: 10 * 60 + 30 },
    });

    expect(result.placements[0]).toMatchObject({
      outcome: "locked",
      reason: "started",
      to: { time: "10:00" },
    });
    expect(result.retimedCount).toBe(0);
  });

  it("displaces a live booking when the new start has already passed today", () => {
    const block = stream({ id: 1, startTime: "14:00", endTime: "16:00" });
    const result = plan({
      candidate: { ...block, startTime: "13:00", endTime: "16:00" },
      blocks: [block],
      bookings: [booking(1, { time: "14:00" })],
      now: { date: "2026-11-04", minutes: 13 * 60 + 30 },
    });

    expect(result.placements[0]).toMatchObject({
      outcome: "needs_rebooking",
      reason: "start_moved",
    });
  });
});
