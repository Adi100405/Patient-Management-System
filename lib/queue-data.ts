import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, patients } from "@/db/schema";
import { buildQueue, type QueueEntry, type QueueRow, type QueueView } from "./queue";

/**
 * The queue reads.
 *
 * Every number on a dashboard comes from here, so the doctor board, the
 * patient's own status line and the assistant all describe the same queue in
 * the same words.
 */

export type DoctorQueueRow = QueueRow & {
  readonly patientName: string;
  readonly patientPhone: string | null;
};

/** Every visit one doctor has on one day, waiting or not. */
export async function doctorQueueForDate(
  doctorId: number,
  date: string,
): Promise<readonly DoctorQueueRow[]> {
  const db = getDb();
  return db
    .select({
      id: appointments.id,
      status: appointments.status,
      appointmentTime: appointments.appointmentTime,
      checkedInAt: appointments.checkedInAt,
      tokenNumber: appointments.tokenNumber,
      servingStartedAt: appointments.servingStartedAt,
      patientName: patients.fullName,
      patientPhone: patients.phone,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .where(
      and(eq(appointments.doctorId, doctorId), eq(appointments.appointmentDate, date)),
    )
    .orderBy(asc(appointments.appointmentTime), asc(appointments.id));
}

/** The queue for one doctor on one day. */
export async function doctorQueueView(
  doctorId: number,
  date: string,
): Promise<{ readonly rows: readonly DoctorQueueRow[]; readonly view: QueueView }> {
  const rows = await doctorQueueForDate(doctorId, date);
  return { rows, view: buildQueue(rows) };
}

/** Queue rows by appointment id, for lookups against a built view. */
export function indexQueueRows<T extends QueueRow>(rows: readonly T[]): Map<number, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/** Queue entries by appointment id, across every bucket of a view. */
export function indexQueueEntries(view: QueueView): Map<number, QueueEntry> {
  const entries = new Map<number, QueueEntry>();
  for (const entry of [
    ...(view.serving ? [view.serving] : []),
    ...view.waiting,
    ...view.notCheckedIn,
    ...view.done,
  ]) {
    entries.set(entry.id, entry);
  }
  return entries;
}

export type PatientQueueStatus = {
  readonly state: QueueStateName;
  readonly position: number | null;
  readonly token: string | null;
  readonly checkedInAt: Date | null;
  readonly servingStartedAt: Date | null;
  /** How many people are ahead of this patient in the live queue. */
  readonly waitingCount: number;
};

type QueueStateName = "serving" | "waiting" | "not_checked_in" | "done";

/**
 * Where one patient's own visit stands in the queue.
 *
 * The patient is told their token and their place, never who else is in the
 * room: the queue holds other people's names and that stays inside the
 * doctor's dashboard.
 */
export async function patientQueueStatus(
  patientId: number,
  date: string,
): Promise<Map<number, PatientQueueStatus>> {
  const db = getDb();
  const own = await db
    .select({
      id: appointments.id,
      doctorId: appointments.doctorId,
      status: appointments.status,
      appointmentTime: appointments.appointmentTime,
      checkedInAt: appointments.checkedInAt,
      tokenNumber: appointments.tokenNumber,
      servingStartedAt: appointments.servingStartedAt,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.patientId, patientId),
        eq(appointments.appointmentDate, date),
      ),
    );

  if (own.length === 0) return new Map();

  const doctorIds = [...new Set(own.map((row) => row.doctorId))];
  const views = new Map<number, QueueView>();
  const entries = new Map<number, Map<number, QueueEntry>>();
  for (const doctorId of doctorIds) {
    const rows = await doctorQueueForDate(doctorId, date);
    const view = buildQueue(rows);
    views.set(doctorId, view);
    entries.set(doctorId, indexQueueEntries(view));
  }

  const status = new Map<number, PatientQueueStatus>();
  for (const row of own) {
    const view = views.get(row.doctorId);
    const entry = entries.get(row.doctorId)?.get(row.id);
    if (!view || !entry) continue;

    status.set(row.id, {
      state: entry.state,
      position: entry.position,
      token: entry.token,
      checkedInAt: entry.checkedInAt,
      servingStartedAt: entry.servingStartedAt,
      waitingCount: view.waiting.length,
    });
  }

  return status;
}
