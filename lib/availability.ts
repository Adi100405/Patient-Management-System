import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { availability, availabilityDates } from "@/db/schema";
import type { ScheduleBlock } from "@/lib/schedule";

/**
 * Loads a doctor's published schedule blocks with the dates each one applies
 * to, as the domain understands them.
 *
 * A weekly block comes back with its weekday and no dates; a date-based block
 * comes back with no weekday and the dates it opens on.
 */
export async function blocksForDoctor(doctorId: number): Promise<ScheduleBlock[]> {
  return blocksForDoctors([doctorId]).then((byDoctor) => byDoctor.get(doctorId) ?? []);
}

/** The same, for several doctors at once, keyed by doctor id. */
export async function blocksForDoctors(
  doctorIds: readonly number[],
): Promise<Map<number, ScheduleBlock[]>> {
  const byDoctor = new Map<number, ScheduleBlock[]>();
  if (doctorIds.length === 0) return byDoctor;

  const db = getDb();
  const rows = await db
    .select()
    .from(availability)
    .where(
      and(
        inArray(availability.doctorId, [...doctorIds]),
        eq(availability.isActive, true),
      ),
    );

  const dateRows = rows.length
    ? await db
        .select()
        .from(availabilityDates)
        .where(
          inArray(
            availabilityDates.availabilityId,
            rows.map((row) => row.id),
          ),
        )
    : [];

  const datesByBlock = new Map<number, string[]>();
  for (const row of dateRows) {
    datesByBlock.set(row.availabilityId, [
      ...(datesByBlock.get(row.availabilityId) ?? []),
      row.date,
    ]);
  }

  for (const row of rows) {
    const block: ScheduleBlock = {
      id: row.id,
      schedulingType: row.schedulingType,
      dayOfWeek: row.dayOfWeek,
      dates: datesByBlock.get(row.id) ?? [],
      startTime: row.startTime,
      endTime: row.endTime,
      slotMinutes: row.slotMinutes,
      capacity: row.capacity,
    };
    byDoctor.set(row.doctorId, [...(byDoctor.get(row.doctorId) ?? []), block]);
  }

  return byDoctor;
}
