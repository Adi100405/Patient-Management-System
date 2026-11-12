import {
  blockAppliesOn,
  positionsFor,
  seatFor,
  slotHasStarted,
  windowIsClosed,
  type ScheduleBlock,
  type SchedulingType,
} from "./schedule";
import { addDays, type ClinicClock } from "./slots";

/**
 * How far a displaced visit is allowed to travel before it is parked in
 * `needs_rebooking`: the original day plus the next seven days. Same-day
 * capacity is always tried first, so a shrink usually costs minutes, not days.
 */
export const REBOOKING_HORIZON_DAYS = 7;

/** One live booking as the displacement planner sees it. */
export type DisplacementBooking = {
  readonly id: number;
  readonly availabilityId: number | null;
  readonly date: string;
  readonly time: string;
  readonly seatNumber: number;
  /** When the patient joined the queue; ties break on appointment id. */
  readonly queueSince: Date | string;
};

/** Why a visit was displaced. */
export type DisplacementReason =
  | "capacity"
  | "slot_removed"
  | "window_closed"
  | "start_moved";

type Placement = {
  readonly availabilityId: number;
  readonly date: string;
  readonly time: string;
  readonly seatNumber: number;
};

export type DisplacementPlacement = {
  readonly appointmentId: number;
  readonly from: {
    readonly availabilityId: number | null;
    readonly date: string;
    readonly time: string;
    readonly seatNumber: number;
  };
  /**
   * Where the visit ends up. `null` means no slot was found inside the horizon
   * and the row must become `needs_rebooking`.
   */
  readonly to: Placement | null;
  readonly outcome: "stayed" | "retimed" | "moved" | "needs_rebooking" | "locked";
  readonly reason: DisplacementReason | "started" | null;
  /** FIFO place the patient held in the slot they were booked into. */
  readonly queueRank: number;
};

export type DisplacementPlan = {
  readonly placements: readonly DisplacementPlacement[];
  readonly stayedCount: number;
  readonly lockedCount: number;
  readonly retimedCount: number;
  readonly movedCount: number;
  readonly needsRebookingCount: number;
  /** Visits whose date, time or availability changed. */
  readonly affectedCount: number;
  /** Visits that lost their slot: moved plus needs-rebooking. */
  readonly displacedCount: number;
  readonly hasChanges: boolean;
};

export type QueueEntry = {
  readonly id: number;
  readonly queueSince: Date | string;
};

/** FIFO order: oldest `queue_since` first, appointment id as the stable tie-break. */
export function compareQueue(a: QueueEntry, b: QueueEntry): number {
  const aTime = new Date(a.queueSince).getTime();
  const bTime = new Date(b.queueSince).getTime();
  if (aTime !== bTime) return aTime - bTime;
  return a.id - b.id;
}

/** The queue order for one slot. Seat numbers deliberately play no part. */
export function queueOrder<T extends QueueEntry>(bookings: readonly T[]): T[] {
  return [...bookings].sort(compareQueue);
}

/** 1-based FIFO ranks for one slot, keyed by appointment id. */
export function queueRanks(bookings: readonly QueueEntry[]): Map<number, number> {
  const ranks = new Map<number, number>();
  queueOrder(bookings).forEach((booking, index) => ranks.set(booking.id, index + 1));
  return ranks;
}

export type DisplacementInput = {
  /** The block as it will be published if the doctor confirms the edit. */
  readonly candidate: ScheduleBlock;
  /** The doctor's currently published blocks; the candidate replaces its id. */
  readonly blocks: readonly ScheduleBlock[];
  /** Every upcoming booked visit for this doctor, across all their blocks. */
  readonly bookings: readonly DisplacementBooking[];
  readonly now: ClinicClock;
  /** Defaults to seven days after the displaced visit's own date. */
  readonly horizonDays?: number;
};

type Pool = {
  readonly availabilityId: number;
  readonly date: string;
  readonly time: string;
  readonly seats: number;
  readonly schedulingType: SchedulingType;
};

type Decision =
  | { readonly booking: DisplacementBooking; readonly kind: "kept"; readonly placement: Placement }
  | {
      readonly booking: DisplacementBooking;
      readonly kind: "retimed";
      readonly placement: Placement;
      readonly reason: "start_moved";
    }
  | { readonly booking: DisplacementBooking; readonly kind: "locked" }
  | {
      readonly booking: DisplacementBooking;
      readonly kind: "displaced";
      readonly reason: DisplacementReason;
    };

/**
 * Plans what an elastic edit does to the doctor's live bookings.
 *
 * The doctor may shrink, move or close a window as far as they like. Bookings
 * never veto the edit: the planner keeps the oldest visits first, retimes a
 * stream whose start moved, and places everyone else into the earliest free
 * slot on the same day or within the following seven days. A visit that is
 * already underway is locked in place, because moving a patient mid-visit is
 * not a reschedule.
 *
 * Pure by design: all dates, bookings and the clinic clock arrive as data, so
 * the policy is testable without a database.
 */
export function planDisplacement(input: DisplacementInput): DisplacementPlan {
  const blocks = withCandidate(input.blocks, input.candidate);
  const candidateBookings = input.bookings.filter(
    (booking) => booking.availabilityId === input.candidate.id,
  );

  const rankings = rankBookingsByOldSlot(candidateBookings);
  const decisions = new Map<number, Decision>();

  const locked = candidateBookings.filter((booking) =>
    slotHasStarted(booking.date, booking.time, input.now),
  );
  for (const booking of locked) {
    decisions.set(booking.id, { booking, kind: "locked" });
  }

  const movable = candidateBookings.filter((booking) => !decisions.has(booking.id));
  if (input.candidate.schedulingType === "stream") {
    planStream(input, movable, decisions);
  } else {
    planWave(input, movable, decisions);
  }

  const displaced = movable
    .filter((booking) => decisions.get(booking.id)?.kind === "displaced")
    .sort(compareQueue);

  // Occupancy after the edit, before displaced visits are placed. Seats are
  // tracked, not just counts, because the database's unique index is on the
  // physical seat and a moved patient must take a genuinely free one.
  const usedSeats = occupancyAfterEdit(input.bookings, decisions);
  const horizon = input.horizonDays ?? REBOOKING_HORIZON_DAYS;
  const placementsByAppointment = new Map<number, DisplacementPlacement>();

  for (const booking of displaced) {
    const decision = decisions.get(booking.id);
    if (decision?.kind !== "displaced") continue;

    const target = findPlacement({
      booking,
      blocks,
      usedSeats,
      now: input.now,
      horizonDays: horizon,
    });

    placementsByAppointment.set(booking.id, {
      appointmentId: booking.id,
      from: fromBooking(booking),
      to: target,
      outcome: target ? "moved" : "needs_rebooking",
      reason: decision.reason,
      queueRank: rankings.get(booking.id) ?? 1,
    });
  }

  for (const booking of candidateBookings) {
    if (placementsByAppointment.has(booking.id)) continue;
    const decision = decisions.get(booking.id);
    if (!decision) continue;

    if (decision.kind === "kept") {
      placementsByAppointment.set(booking.id, {
        appointmentId: booking.id,
        from: fromBooking(booking),
        to: decision.placement,
        outcome: "stayed",
        reason: null,
        queueRank: rankings.get(booking.id) ?? 1,
      });
    } else if (decision.kind === "retimed") {
      placementsByAppointment.set(booking.id, {
        appointmentId: booking.id,
        from: fromBooking(booking),
        to: decision.placement,
        outcome: "retimed",
        reason: decision.reason,
        queueRank: rankings.get(booking.id) ?? 1,
      });
    } else if (decision.kind === "locked") {
      placementsByAppointment.set(booking.id, {
        appointmentId: booking.id,
        from: fromBooking(booking),
        to: placementFor(booking, input.candidate.id),
        outcome: "locked",
        reason: "started",
        queueRank: rankings.get(booking.id) ?? 1,
      });
    }
  }

  const placements = candidateBookings
    .map((booking) => placementsByAppointment.get(booking.id))
    .filter((placement): placement is DisplacementPlacement => placement !== undefined)
    .sort((a, b) => {
      const left = input.bookings.find((booking) => booking.id === a.appointmentId);
      const right = input.bookings.find((booking) => booking.id === b.appointmentId);
      if (!left || !right) return a.appointmentId - b.appointmentId;
      return (
        left.date.localeCompare(right.date) ||
        left.time.localeCompare(right.time) ||
        compareQueue(left, right)
      );
    });

  const stayedCount = placements.filter((placement) => placement.outcome === "stayed").length;
  const lockedCount = placements.filter((placement) => placement.outcome === "locked").length;
  const retimedCount = placements.filter((placement) => placement.outcome === "retimed").length;
  const movedCount = placements.filter((placement) => placement.outcome === "moved").length;
  const needsRebookingCount = placements.filter(
    (placement) => placement.outcome === "needs_rebooking",
  ).length;
  const affectedCount = retimedCount + movedCount + needsRebookingCount;

  return {
    placements,
    stayedCount,
    lockedCount,
    retimedCount,
    movedCount,
    needsRebookingCount,
    affectedCount,
    displacedCount: movedCount + needsRebookingCount,
    hasChanges: affectedCount > 0,
  };
}

function planWave(
  input: DisplacementInput,
  movable: readonly DisplacementBooking[],
  decisions: Map<number, Decision>,
) {
  const positions = new Map(
    positionsFor(input.candidate).map((position) => [position.time, position.seats]),
  );
  const closed = windowIsClosed(input.candidate);
  const bySlot = groupBy(movable, (booking) => slotKey(booking.date, booking.time));

  for (const bookings of bySlot.values()) {
    const time = bookings[0]!.time;
    const seats = positions.get(time);
    queueOrder(bookings).forEach((booking, index) => {
      if (seats !== undefined && index < seats) {
        decisions.set(booking.id, {
          booking,
          kind: "kept",
          placement: placementFor(booking, input.candidate.id),
        });
        return;
      }

      decisions.set(booking.id, {
        booking,
        kind: "displaced",
        reason: closed ? "window_closed" : seats === undefined ? "slot_removed" : "capacity",
      });
    });
  }
}

function planStream(
  input: DisplacementInput,
  movable: readonly DisplacementBooking[],
  decisions: Map<number, Decision>,
) {
  if (windowIsClosed(input.candidate)) {
    for (const booking of movable) {
      decisions.set(booking.id, {
        booking,
        kind: "displaced",
        reason: "window_closed",
      });
    }
    return;
  }

  // Capacity is per occurrence, so each date queues and fills on its own. A
  // weekly stream must not let next week's bookings consume this week's places.
  const byDate = groupBy(movable, (booking) => booking.date);

  for (const [date, bookings] of byDate) {
    const ordered = queueOrder(bookings);
    let kept = 0;

    for (const booking of ordered) {
      const atNewStart = booking.time === input.candidate.startTime;
      // A window that now starts in the past cannot receive a live booking
      // today, even if that booking was for a later start before the edit.
      const canOccupy =
        atNewStart || !slotHasStarted(date, input.candidate.startTime, input.now);

      if (canOccupy && kept < input.candidate.capacity) {
        kept += 1;
        const placement = {
          availabilityId: input.candidate.id,
          date,
          time: input.candidate.startTime,
          seatNumber: booking.seatNumber,
        };
        if (atNewStart) {
          decisions.set(booking.id, { booking, kind: "kept", placement });
        } else {
          decisions.set(booking.id, {
            booking,
            kind: "retimed",
            placement,
            reason: "start_moved",
          });
        }
        continue;
      }

      decisions.set(booking.id, {
        booking,
        kind: "displaced",
        reason: canOccupy ? "capacity" : "start_moved",
      });
    }
  }
}

function findPlacement(input: {
  readonly booking: DisplacementBooking;
  readonly blocks: readonly ScheduleBlock[];
  readonly usedSeats: Map<string, Set<number>>;
  readonly now: ClinicClock;
  readonly horizonDays: number;
}): Placement | null {
  for (let offset = 0; offset <= input.horizonDays; offset += 1) {
    const date = addDays(input.booking.date, offset);
    for (const pool of poolsForDate(input.blocks, date, input.now)) {
      const key = slotKey(pool.date, pool.time);
      const used = input.usedSeats.get(key) ?? new Set<number>();
      if (used.size >= pool.seats) continue;

      const seat = seatFor([...used], pool.seats);
      if (seat === null) continue;

      used.add(seat);
      input.usedSeats.set(key, used);

      return {
        availabilityId: pool.availabilityId,
        date: pool.date,
        time: pool.time,
        seatNumber: seat,
      };
    }
  }

  return null;
}

function occupancyAfterEdit(
  bookings: readonly DisplacementBooking[],
  decisions: Map<number, Decision>,
): Map<string, Set<number>> {
  const usedBySlot = new Map<string, Set<number>>();

  for (const booking of bookings) {
    const decision = decisions.get(booking.id);
    if (decision?.kind === "displaced") continue;

    const time =
      decision?.kind === "kept" || decision?.kind === "retimed"
        ? decision.placement.time
        : booking.time;
    const key = slotKey(booking.date, time);
    const seats = usedBySlot.get(key) ?? new Set<number>();
    // A wave booking and a stream booking can never share a live slot: sibling
    // overlap is refused. The same seat number therefore cannot collide here.
    seats.add(booking.seatNumber);
    usedBySlot.set(key, seats);
  }

  return usedBySlot;
}

function poolsForDate(
  blocks: readonly ScheduleBlock[],
  date: string,
  now: ClinicClock,
): readonly Pool[] {
  const pools: Pool[] = [];

  for (const block of blocks) {
    if (!blockAppliesOn(block, date) || windowIsClosed(block)) continue;

    if (block.schedulingType === "stream") {
      if (slotHasStarted(date, block.startTime, now)) continue;
      pools.push({
        availabilityId: block.id,
        date,
        time: block.startTime,
        seats: block.capacity,
        schedulingType: "stream",
      });
      continue;
    }

    for (const position of positionsFor(block)) {
      if (slotHasStarted(date, position.time, now)) continue;
      pools.push({
        availabilityId: block.id,
        date,
        time: position.time,
        seats: position.seats,
        schedulingType: "wave",
      });
    }
  }

  return pools.sort(
    (a, b) => a.time.localeCompare(b.time) || a.availabilityId - b.availabilityId,
  );
}

function rankBookingsByOldSlot(
  bookings: readonly DisplacementBooking[],
): Map<number, number> {
  const ranks = new Map<number, number>();
  for (const group of groupBy(bookings, (booking) => slotKey(booking.date, booking.time)).values()) {
    for (const [id, rank] of queueRanks(group)) ranks.set(id, rank);
  }
  return ranks;
}

function fromBooking(booking: DisplacementBooking) {
  return {
    availabilityId: booking.availabilityId,
    date: booking.date,
    time: booking.time,
    seatNumber: booking.seatNumber,
  };
}

function placementFor(booking: DisplacementBooking, availabilityId: number): Placement {
  return {
    availabilityId,
    date: booking.date,
    time: booking.time,
    seatNumber: booking.seatNumber,
  };
}

function withCandidate(
  blocks: readonly ScheduleBlock[],
  candidate: ScheduleBlock,
): readonly ScheduleBlock[] {
  if (!blocks.some((block) => block.id === candidate.id)) return [...blocks, candidate];
  return blocks.map((block) => (block.id === candidate.id ? candidate : block));
}

function slotKey(date: string, time: string) {
  return `${date}T${time}`;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), item]);
  }
  return groups;
}
