import { dayOfWeekFor, toMinutes, toTime } from "./slots";

/**
 * The two scheduling styles a doctor can publish.
 *
 * Wave: a repeated visit slot. Every patient in the wave starts at the same
 * time and the doctor sees them together, so the capacity counts patients per
 * slot.
 *
 * Stream: a continuous run of appointments. The window is divided into as many
 * evenly spaced positions as the capacity allows and each position holds one
 * patient, so the capacity counts patients in the window.
 */
export const SCHEDULING_TYPES = ["wave", "stream"] as const;

export type SchedulingType = (typeof SCHEDULING_TYPES)[number];

/** The most patients one wave slot or one stream window may hold. */
export const MAX_CAPACITY = 50;

/** The most explicit dates one block may list. */
export const MAX_BLOCK_DATES = 30;

/** How a block turns its window into bookable positions. */
export type ScheduleRules = {
  readonly schedulingType: SchedulingType;
  /** "09:00" */
  readonly startTime: string;
  /** "13:00" */
  readonly endTime: string;
  /**
   * Wave: the length of one visit, so the next patient starts when it ends.
   * Stream: the derived distance between two positions, which is the window
   * divided by the capacity.
   */
  readonly slotMinutes: number;
  readonly capacity: number;
};

/** A stored block: its rules plus the dates it applies to. */
export type ScheduleBlock = ScheduleRules & {
  readonly id: number;
  /** 0 = Sunday ... 6 = Saturday. Null means the block follows an explicit date list. */
  readonly dayOfWeek: number | null;
  /** The explicit dates a date-based block opens on. */
  readonly dates: readonly string[];
};

/** One bookable start time inside a block, and how many patients it may hold. */
export type Position = {
  readonly time: string;
  readonly seats: number;
};

/** A block that repeats every week on one weekday. */
export type WeeklyBlock = ScheduleBlock & { readonly dayOfWeek: number };

/** A block that opens on an explicit list of dates. */
export type DatedBlock = ScheduleBlock & { readonly dayOfWeek: null };

/** A position as the patient sees it: what is left of it. */
export type SlotOffer = {
  readonly time: string;
  readonly availabilityId: number;
  readonly schedulingType: SchedulingType;
  readonly seats: number;
  readonly taken: number;
  readonly free: number;
};

/**
 * The distance between two stream positions: the window divided by the
 * capacity. Stream needs no visit length from the doctor — the capacity alone
 * decides how many appointments the window holds and how far apart they sit.
 */
export function streamSpacing(startTime: string, endTime: string, capacity: number) {
  const span = toMinutes(endTime) - toMinutes(startTime);
  return Math.max(1, Math.round(span / Math.max(1, capacity)));
}

/** Every bookable position in a block, in clock order. */
export function positionsFor(rules: ScheduleRules): readonly Position[] {
  switch (rules.schedulingType) {
    case "wave":
      return wavePositions(rules);
    case "stream":
      return streamPositions(rules);
    default:
      return assertNever(rules.schedulingType);
  }
}

/**
 * Wave positions start at the window's start and are one visit apart. A visit
 * that would run past the window's end is not offered.
 */
function wavePositions(rules: ScheduleRules): readonly Position[] {
  const positions: Position[] = [];
  const start = toMinutes(rules.startTime);
  const end = toMinutes(rules.endTime);

  for (let t = start; t + rules.slotMinutes <= end; t += rules.slotMinutes) {
    positions.push({ time: toTime(t), seats: rules.capacity });
  }

  return positions;
}

/**
 * Stream positions are the capacity itself: one patient each, spaced evenly
 * across the window.
 */
function streamPositions(rules: ScheduleRules): readonly Position[] {
  const positions: Position[] = [];
  const start = toMinutes(rules.startTime);

  for (let index = 0; index < rules.capacity; index += 1) {
    positions.push({ time: toTime(start + index * rules.slotMinutes), seats: 1 });
  }

  return positions;
}

/**
 * The lowest seat a new patient may take, or null when the slot is full.
 * Seats are numbered from one, so the first free seat is the one to hand out.
 */
export function seatFor(takenSeats: readonly number[], seats: number): number | null {
  for (let seat = 1; seat <= seats; seat += 1) {
    if (!takenSeats.includes(seat)) return seat;
  }

  return null;
}

/**
 * Whether a block is open on a date. A weekly block answers to its weekday; a
 * date-based block answers to its explicit list.
 */
export function blockAppliesOn(block: ScheduleBlock, date: string): boolean {
  if (block.dayOfWeek !== null) return block.dayOfWeek === dayOfWeekFor(date);
  return block.dates.includes(date);
}

/**
 * Whether two blocks cover the same clock time on the same date.
 *
 * A doctor may not publish overlapping blocks, because the two would compete
 * for the same seats and the seat numbers would stop meaning anything.
 */
export function blocksConflict(a: ScheduleBlock, b: ScheduleBlock): boolean {
  if (!rangesOverlap(a, b)) return false;
  return shareADate(a, b);
}

/** Half-open overlap: a window that ends exactly when the next begins is fine. */
function rangesOverlap(a: ScheduleRules, b: ScheduleRules): boolean {
  return (
    toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime)
  );
}

/**
 * Whether the two blocks are ever open on the same date — the same weekday
 * for weekly blocks, a shared date for dated ones, and a dated block landing
 * on a weekly block's weekday for the mixed case.
 */
function shareADate(a: ScheduleBlock, b: ScheduleBlock): boolean {
  if (a.dayOfWeek !== null && b.dayOfWeek !== null) return a.dayOfWeek === b.dayOfWeek;
  if (a.dayOfWeek !== null) return b.dates.some((date) => dayOfWeekFor(date) === a.dayOfWeek);
  if (b.dayOfWeek !== null) return a.dates.some((date) => dayOfWeekFor(date) === b.dayOfWeek);
  return a.dates.some((date) => b.dates.includes(date));
}

/** A date a patient might be offered, with the weekday it falls on. */
export type DateCandidate = {
  readonly date: string;
  readonly dayOfWeek: number;
};

/**
 * The dates a patient may book: the days a weekly block covers, plus the
 * explicit dates a dated block opens.
 */
export function openDates<T extends DateCandidate>(
  blocks: readonly ScheduleBlock[],
  candidates: readonly T[],
): readonly T[] {
  return candidates.filter((candidate) =>
    blocks.some((block) => blockAppliesOn(block, candidate.date)),
  );
}

export type OfferInput = {
  readonly blocks: readonly ScheduleBlock[];
  readonly date: string;
  /** Start time to the number of seats already taken at that time. */
  readonly takenSeats: ReadonlyMap<string, number>;
  readonly now: { readonly date: string; readonly minutes: number };
};

/**
 * Every position a patient may still book on a date, with its seat counts.
 * A position whose seats are all taken is returned with no free seats; the
 * booking page drops those, and the doctor sees the whole picture.
 */
export function offersFor(input: OfferInput): readonly SlotOffer[] {
  const offers: SlotOffer[] = [];

  for (const block of input.blocks) {
    if (!blockAppliesOn(block, input.date)) continue;

    for (const position of positionsFor(block)) {
      if (slotHasStarted(input.date, position.time, input.now)) continue;

      const taken = input.takenSeats.get(position.time) ?? 0;
      offers.push({
        time: position.time,
        availabilityId: block.id,
        schedulingType: block.schedulingType,
        seats: position.seats,
        taken,
        free: Math.max(0, position.seats - taken),
      });
    }
  }

  return offers.sort((a, b) => a.time.localeCompare(b.time));
}

/** A position that has already begun today cannot be booked. */
export function slotHasStarted(
  date: string,
  time: string,
  now: { readonly date: string; readonly minutes: number },
): boolean {
  if (date !== now.date) return false;
  return toMinutes(time) <= now.minutes;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled scheduling type: ${String(value)}`);
}
