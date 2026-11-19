"use server";

import { and, eq, isNull, lte, max, sql } from "drizzle-orm";
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
import { clinicClock, clinicNow } from "@/lib/slots";

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
 * The front desk does this, for any doctor in the clinic: the doctor does
 * not sit at reception, so the desk is the one place a patient arrives. The
 * write is guarded on the visit not being checked in yet, so two clicks — or
 * two desks at once — can never check the same patient in twice: the second
 * attempt simply finds nothing to update.
 */
export async function checkInAppointment(
  _prev: QueueActionState,
  formData: FormData,
): Promise<QueueActionState> {
  const session = await requireSession();
  if (session.role !== "receptionist") {
    return { error: "Only the front desk can check a patient in." };
  }

  const id = Number(formData.get("appointmentId"));
  if (!Number.isInteger(id) || id <= 0) {
    return { error: "That request could not be understood." };
  }

  const db = getDb();
  const [appointment] = await db
    .select({
      id: appointments.id,
      doctorId: appointments.doctorId,
      status: appointments.status,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      checkedInAt: appointments.checkedInAt,
      tokenNumber: appointments.tokenNumber,
    })
    .from(appointments)
    .where(eq(appointments.id, id))
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
    // The token belongs to the visit's doctor and day, not to whoever is at
    // the desk: the number on the slip means the same thing on every board.
    const token = await nextToken(db, appointment.doctorId, appointment.date);
    try {
      const updated = await db
        .update(appointments)
        .set({ checkedInAt: new Date(), tokenNumber: token })
        .where(
          and(
            eq(appointments.id, appointment.id),
            eq(appointments.status, "booked"),
            sql`${appointments.checkedInAt} is null`,
          ),
        )
        .returning({ id: appointments.id });

      if (updated.length > 0) {
        revalidatePath("/dashboard/doctor");
        revalidatePath("/dashboard/receptionist");
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
 * people in front of the doctor at once. The doctor calls them in — the desk
 * hands out the tokens.
 */
export async function callNextPatient(): Promise<QueueActionState> {
  const session = await requireSession();
  if (session.role !== "doctor") {
    return { error: "Only the doctor can call the next patient." };
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
  revalidatePath("/dashboard/receptionist");
  revalidatePath("/dashboard/patient");
  return null;
}

/**
 * Records that a patient never turned up.
 *
 * This is the desk's own outcome, for the one case the desk can see: the
 * visit is booked for today, its slot time has passed, and nobody ever
 * checked in — so there is no token and nobody was waiting. A patient who
 * did check in and then left is a clinical outcome, and the doctor closes it.
 */
export async function markNoShowAtDesk(
  _prev: QueueActionState,
  formData: FormData,
): Promise<QueueActionState> {
  const session = await requireSession();
  if (session.role !== "receptionist") {
    return { error: "Only the front desk can record a no-show." };
  }

  const id = Number(formData.get("appointmentId"));
  if (!Number.isInteger(id) || id <= 0) {
    return { error: "That request could not be understood." };
  }

  const db = getDb();
  // One instant for both the date and the clock, so they can never disagree
  // if the clinic day flips between the two reads.
  const instant = new Date();
  const now = clinicNow(instant);

  const updated = await db
    .update(appointments)
    .set({ status: "no_show" })
    .where(
      and(
        eq(appointments.id, id),
        eq(appointments.status, "booked"),
        eq(appointments.appointmentDate, now.date),
        isNull(appointments.checkedInAt),
        lte(appointments.appointmentTime, clinicClock(instant)),
      ),
    )
    .returning({ id: appointments.id });

  if (updated.length === 0) {
    // Diagnose the miss so the desk sees why, instead of a silent no-op.
    const [appointment] = await db
      .select({
        status: appointments.status,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
        checkedInAt: appointments.checkedInAt,
      })
      .from(appointments)
      .where(eq(appointments.id, id))
      .limit(1);

    if (!appointment) return { error: "That appointment was not found." };
    if (appointment.status !== "booked") {
      return { error: "That visit has already been resolved." };
    }
    if (appointment.checkedInAt) {
      return { error: "That patient has already checked in." };
    }
    if (appointment.date !== now.date) {
      return { error: "Only today's visits can be closed at the desk." };
    }
    return { error: "That visit is not due yet." };
  }

  revalidatePath("/dashboard/doctor");
  revalidatePath("/dashboard/receptionist");
  revalidatePath("/dashboard/patient");
  return null;
}
