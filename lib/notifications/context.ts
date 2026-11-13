import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appointments, availability, doctors, patients, payments, users } from "@/db/schema";
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
      doctorId: doctors.id,
      doctorName: doctors.fullName,
      specialization: doctors.specialization,
      fee: doctors.consultationFee,
      // Newest settled payment for this visit, so a payment-confirmed email can
      // link straight to its receipt. Null while nothing has been captured.
      paymentId: sql<number | null>`(
        select ${payments.id} from ${payments}
        where ${payments.appointmentId} = ${appointments.id}
          and ${payments.status} = 'succeeded'
        order by ${payments.id} desc
        limit 1
      )`,
      // How the visit was published: a wave slot, or a stream window that the
      // patient booked as one start–end item.
      schedulingType: availability.schedulingType,
      visitEndTime: availability.endTime,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .innerJoin(users, eq(users.id, patients.userId))
    .innerJoin(doctors, eq(doctors.id, appointments.doctorId))
    .leftJoin(availability, eq(availability.id, appointments.availabilityId))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!row || !row.patientEmail) return null;

  return {
    appointmentId: row.appointmentId,
    patientName: row.patientName,
    patientEmail: row.patientEmail,
    patientPhone: row.patientPhone,
    patientUserId: row.patientUserId,
    doctorId: row.doctorId,
    doctorName: row.doctorName,
    specialization: row.specialization,
    date: row.date,
    time: row.time,
    reason: row.reason,
    fee: row.fee,
    currency: "INR",
    paymentId: row.paymentId,
    schedulingType: row.schedulingType ?? "wave",
    visitEndTime: row.schedulingType === "stream" ? row.visitEndTime : null,
  };
}
