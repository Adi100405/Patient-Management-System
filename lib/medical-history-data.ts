import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, medicalHistoryEntries } from "@/db/schema";
import { normalizeBloodGroup, type MedicalRecordFields } from "./medical-history";

/**
 * The medical-history reads.
 *
 * Revisions are returned newest first, so `revisions[0]` is the current record
 * and everything after it is the audit trail. The patient dashboard and the
 * doctor's patient page read through here, which keeps "current" defined in
 * exactly one place: the newest row.
 */

export type MedicalHistoryRevision = MedicalRecordFields & {
  readonly id: number;
  readonly patientId: number;
  readonly recordedByUserId: number | null;
  readonly recordedByName: string;
  readonly recordedByRole: string;
  readonly createdAt: Date;
};

const revisionColumns = {
  id: medicalHistoryEntries.id,
  patientId: medicalHistoryEntries.patientId,
  bloodGroup: medicalHistoryEntries.bloodGroup,
  allergies: medicalHistoryEntries.allergies,
  conditions: medicalHistoryEntries.conditions,
  medications: medicalHistoryEntries.medications,
  notes: medicalHistoryEntries.notes,
  recordedByUserId: medicalHistoryEntries.recordedByUserId,
  recordedByName: medicalHistoryEntries.recordedByName,
  recordedByRole: medicalHistoryEntries.recordedByRole,
  createdAt: medicalHistoryEntries.createdAt,
};

export async function medicalHistoryRevisions(
  patientId: number,
  limit = 50,
): Promise<readonly MedicalHistoryRevision[]> {
  const db = getDb();
  const rows = await db
    .select(revisionColumns)
    .from(medicalHistoryEntries)
    .where(eq(medicalHistoryEntries.patientId, patientId))
    .orderBy(desc(medicalHistoryEntries.createdAt), desc(medicalHistoryEntries.id))
    .limit(limit);

  // The column is free text at the database level. Normalising on read keeps a
  // value written outside the app from entering the typed record untouched.
  return rows.map((row) => ({
    ...row,
    bloodGroup: normalizeBloodGroup(row.bloodGroup),
  }));
}

/** The newest revision, or null when nothing has ever been recorded. */
export async function latestMedicalHistory(
  patientId: number,
): Promise<MedicalHistoryRevision | null> {
  const [latest] = await medicalHistoryRevisions(patientId, 1);
  return latest ?? null;
}

/**
 * Whether a doctor may open and update this patient's record.
 *
 * The rule is a care relationship, not "any doctor in the clinic": at least one
 * appointment — past, present or cancelled — connects the two. The check is
 * repeated inside the save action, because a page guard alone does not protect
 * a server action from a crafted request.
 */
export async function doctorCanAccessPatient(
  doctorId: number,
  patientId: number,
): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        eq(appointments.patientId, patientId),
      ),
    )
    .limit(1);
  return row !== undefined;
}
