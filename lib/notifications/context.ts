import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, doctors, patients, users } from "@/db/schema";
import type { AppointmentMailContext } from "./templates";

/**
 * Resolves everything a template needs for one appointment in a single query.
 * Returns null when the appointment is gone or the patient has no email — the
 * caller treats null as "nothing to send", never as an error.
 */
export async function appointmentMailContext(
  appointmentId: number,
): Promise<AppointmentMailContext | null> {
  const db = getDb();
  const [row] = await db
    .select({
      appointmentId: appointments.id,
      patientUserId: users.id,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      reason: appointments.reason,
      patientName: patients.fullName,
      patientEmail: users.email,
      patientPhone: patients.phone,
      doctorName: doctors.fullName,
      specialization: doctors.specialization,
      fee: doctors.consultationFee,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .innerJoin(users, eq(users.id, patients.userId))
    .innerJoin(doctors, eq(doctors.id, appointments.doctorId))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!row || !row.patientEmail) return null;

  return {
    appointmentId: row.appointmentId,
    patientName: row.patientName,
    patientEmail: row.patientEmail,
    patientPhone: row.patientPhone,
    patientUserId: row.patientUserId,
    doctorName: row.doctorName,
    specialization: row.specialization,
    date: row.date,
    time: row.time,
    reason: row.reason,
    fee: row.fee,
    currency: "INR",
  };
}
