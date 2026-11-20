"use server";

import { and, eq, max, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  appointments,
  DOCTOR_DAY_SERVING_INDEX,
  DOCTOR_DAY_TOKEN_INDEX,
} from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { checkInWindow, formatToken } from "@/lib/queue";
import { doctorQueueView } from "@/lib/queue-data";
import { requireSession } from "@/lib/session";
import { clinicNow } from "@/lib/slots";

export type QueueActionState = { error?: string } | null;

/** How many times a check-in may retry for a free token. */
const MAX_TOKEN_ATTEMPTS = 5;

type Db = ReturnType<typeof getDb>;

/**
 * The next token for one doctor on one day.
 *
 * Tokens are small numbers that only ever go up. A cancelled visit keeps the
 * number it was given, so the next patient is given the next number rather
 * than a recycled one.
 */
async function nextToken(db: Db, doctorId: number, date: string): Promise<number> {
  const [row] = await db
    .select({ highest: max(appointments.tokenNumber) })
    .from(appointments)
    .where(
      and(eq(appointments.doctorId, doctorId), eq(appointments.appointmentDate, date)),
    );
  return (row?.highest ?? 0) + 1;
}

/**
 * Checks a patient in at the desk and gives them their token.
 *
 * Only the doctor who owns the visit can do it, and only for a visit that is
 * booked, today, and inside its check-in window. The write is guarded on the
 * visit not being checked in yet, so two clicks — or two desks at once — can
 * never check the same patient in twice: the second attempt simply finds
 * nothing to update.
 */
export async function checkInAppointment(
  _prev: QueueActionState,
  formData: FormData,
): Promise<QueueActionState> {
  const session = await requireSession();
  if (session.role !== "doctor") {
    return { error: "Only the clinic can check a patient in." };
  }

  const id = Number(formData.get("appointmentId"));
  if (!Number.isInteger(id) || id <= 0) {
    return { error: "That request could not be understood." };
  }

  const db = getDb();
  const [appointment] = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      checkedInAt: appointments.checkedInAt,
      tokenNumber: appointments.tokenNumber,
    })
    .from(appointments)
    .where(
      and(eq(appointments.id, id), eq(appointments.doctorId, session.profileId)),
    )
    .limit(1);

  if (!appointment) return { error: "That appointment was not found." };
  if (appointment.status !== "booked") {
    return { error: "That visit is no longer active." };
  }
  if (appointment.checkedInAt) {
    return {
      error: `Already checked in as token ${formatToken(appointment.tokenNumber) ?? "—"}.`,
    };
  }

  const window = checkInWindow(appointment.date, appointment.time);
  if (window.state === "future") {
    return { error: "Check-in opens on the visit day." };
  }
  if (window.state === "closed") {
    return { error: "That visit is not today." };
  }
  if (window.state === "before") {
    return { error: `Check-in opens at ${window.opensAt}.` };
  }

  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
    const token = await nextToken(db, session.profileId, appointment.date);
    try {
      const updated = await db
        .update(appointments)
        .set({ checkedInAt: new Date(), tokenNumber: token })
        .where(
          and(
            eq(appointments.id, appointment.id),
            eq(appointments.doctorId, session.profileId),
            eq(appointments.status, "booked"),
            sql`${appointments.checkedInAt} is null`,
          ),
        )
        .returning({ id: appointments.id });

      if (updated.length > 0) {
        revalidatePath("/dashboard/doctor");
        revalidatePath("/dashboard/patient");
        return null;
      }

      // Somebody checked this patient in while the desk was talking.
      return { error: "That patient is already checked in." };
    } catch (error) {
      if (!isUniqueViolation(error, DOCTOR_DAY_TOKEN_INDEX)) throw error;
      // Another visit took this token first. The next number is free.
    }
  }

  return { error: "The queue is busy. Try again in a moment." };
}

/**
 * Calls the next waiting patient in.
 *
 * The order is the order people checked in. One patient at a time is in the
 * room: the database refuses a second one, so two clicks can never put two
 * people in front of the doctor at once.
 */
export async function callNextPatient(): Promise<QueueActionState> {
  const session = await requireSession();
  if (session.role !== "doctor") {
    return { error: "Only the clinic can call the next patient." };
  }

  const date = clinicNow().date;
  const { view } = await doctorQueueView(session.profileId, date);

  if (view.serving) {
    return { error: "Finish the current visit before calling the next patient." };
  }
  const next = view.waiting[0];
  if (!next) {
    return { error: "No checked-in patients are waiting." };
  }

  const db = getDb();
  try {
    const updated = await db
      .update(appointments)
      .set({ servingStartedAt: new Date() })
      .where(
        and(
          eq(appointments.id, next.id),
          eq(appointments.doctorId, session.profileId),
          eq(appointments.status, "booked"),
          sql`${appointments.servingStartedAt} is null`,
        ),
      )
      .returning({ id: appointments.id });

    if (updated.length === 0) {
      return { error: "The queue just changed. Try again." };
    }
  } catch (error) {
    if (!isUniqueViolation(error, DOCTOR_DAY_SERVING_INDEX)) throw error;
    return { error: "Somebody else just called the next patient." };
  }

  revalidatePath("/dashboard/doctor");
  revalidatePath("/dashboard/patient");
  return null;
}
