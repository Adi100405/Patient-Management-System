"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { medicalHistoryEntries } from "@/db/schema";
import {
  normalizeMedicalRecord,
  recordsEqual,
} from "@/lib/medical-history";
import {
  doctorCanAccessPatient,
  latestMedicalHistory,
} from "@/lib/medical-history-data";
import { requireSession } from "@/lib/session";

export type MedicalHistoryState = { error?: string; message?: string } | null;

/**
 * Saves a patient's medical history as a new revision.
 *
 * Appends, never updates: the newest row is the current record and the older
 * rows are the audit trail. A save that changes nothing writes nothing, so the
 * history stays a list of real changes rather than a list of button presses.
 *
 * Both gates are checked here even though the page checks them too: the session
 * must be a doctor, and that doctor must have a care relationship with the
 * patient. A crafted request cannot skip the page.
 */
export async function saveMedicalHistory(
  _prev: MedicalHistoryState,
  formData: FormData,
): Promise<MedicalHistoryState> {
  const session = await requireSession();
  if (session.role !== "doctor") {
    return { error: "Only doctors can update a patient's medical record." };
  }

  const patientId = Number(formData.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return { error: "That request could not be understood." };
  }

  if (!(await doctorCanAccessPatient(session.profileId, patientId))) {
    return { error: "You do not have access to this patient's record." };
  }

  const fields = normalizeMedicalRecord({
    bloodGroup: formData.get("bloodGroup"),
    allergies: formData.get("allergies"),
    conditions: formData.get("conditions"),
    medications: formData.get("medications"),
    notes: formData.get("notes"),
  });

  const latest = await latestMedicalHistory(patientId);
  if (latest && recordsEqual(latest, fields)) {
    return { message: "No changes to save." };
  }

  const db = getDb();
  await db.insert(medicalHistoryEntries).values({
    patientId,
    ...fields,
    recordedByUserId: session.userId,
    recordedByName: session.name,
    recordedByRole: session.role,
  });

  revalidatePath(`/dashboard/doctor/patients/${patientId}`);
  revalidatePath("/dashboard/doctor");
  revalidatePath("/dashboard/patient");

  return { message: "Medical history updated." };
}
