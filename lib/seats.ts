import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, patients } from "@/db/schema";

/**
 * The seat numbers already taken at one slot.
 *
 * Seats are numbered from one, so the numbers that are missing are exactly the
 * seats a new patient may take.
 */
export async function takenSeatNumbers(options: {
  readonly doctorId: number;
  readonly date: string;
  readonly time: string;
  /** The appointment being moved, which is not a competitor for its own slot. */
  readonly exceptAppointmentId?: number;
}): Promise<readonly number[]> {
  const db = getDb();
  const rows = await db
    .select({ id: appointments.id, seatNumber: appointments.seatNumber })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, options.doctorId),
        eq(appointments.appointmentDate, options.date),
        eq(appointments.appointmentTime, options.time),
        eq(appointments.status, "booked"),
      ),
    );

  return rows
    .filter((row) => row.id !== options.exceptAppointmentId)
    .map((row) => row.seatNumber);
}

/**
 * How many seats are taken at each start time, for every date in a range.
 *
 * Keyed by date and then by time, because that is the shape the booking page
 * asks the question in.
 */
export async function takenSeatsByTime(options: {
  readonly doctorId: number;
  readonly dateFrom: string;
  readonly dateTo: string;
}): Promise<Map<string, Map<string, number>>> {
  const db = getDb();
  const rows = await db
    .select({ date: appointments.appointmentDate, time: appointments.appointmentTime })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, options.doctorId),
        eq(appointments.status, "booked"),
        gte(appointments.appointmentDate, options.dateFrom),
        lte(appointments.appointmentDate, options.dateTo),
      ),
    );

  const tally = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const byTime = tally.get(row.date) ?? new Map<string, number>();
    byTime.set(row.time, (byTime.get(row.time) ?? 0) + 1);
    tally.set(row.date, byTime);
  }

  return tally;
}

export type BookedAppointmentRow = {
  readonly id: number;
  readonly availabilityId: number | null;
  readonly patientId: number;
  readonly patientName: string;
  readonly date: string;
  readonly time: string;
  readonly seatNumber: number;
  readonly queueSince: Date;
};

/**
 * Every upcoming booked visit for one doctor, across all their blocks.
 *
 * An elastic edit needs the whole picture, not just the edited block: a
 * displaced patient may be placed into a different window on the same day, and
 * the planner must know which seats those windows already hold. Past and
 * cancelled visits are ignored — the window's history is not the window's
 * shape.
 */
export async function bookedUpcomingForDoctor(
  doctorId: number,
  fromDate: string,
): Promise<readonly BookedAppointmentRow[]> {
  const db = getDb();
  return db
    .select({
      id: appointments.id,
      availabilityId: appointments.availabilityId,
      patientId: appointments.patientId,
      patientName: patients.fullName,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      seatNumber: appointments.seatNumber,
      queueSince: appointments.queueSince,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        eq(appointments.status, "booked"),
        gte(appointments.appointmentDate, fromDate),
      ),
    )
    .orderBy(appointments.appointmentDate, appointments.appointmentTime, appointments.queueSince);
}

/** Every upcoming booked visit attached to one availability block. */
export async function bookedUpcomingForAvailability(
  availabilityId: number,
  fromDate: string,
): Promise<readonly BookedAppointmentRow[]> {
  const db = getDb();
  return db
    .select({
      id: appointments.id,
      availabilityId: appointments.availabilityId,
      patientId: appointments.patientId,
      patientName: patients.fullName,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      seatNumber: appointments.seatNumber,
      queueSince: appointments.queueSince,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .where(
      and(
        eq(appointments.availabilityId, availabilityId),
        eq(appointments.status, "booked"),
        gte(appointments.appointmentDate, fromDate),
      ),
    )
    .orderBy(appointments.appointmentDate, appointments.appointmentTime, appointments.queueSince);
}
