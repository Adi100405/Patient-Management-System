import { and, asc, desc, eq, ilike, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  appointments,
  availability,
  doctors,
  payments,
  refunds,
  visitNotes,
} from "@/db/schema";
import { blocksForDoctor } from "@/lib/availability";
import { offersFor } from "@/lib/schedule";
import { takenSeatsByTime } from "@/lib/seats";
import { clinicNow, upcomingDays } from "@/lib/slots";
import { formatDate, formatTime } from "@/lib/utils";
import { signProposal } from "@/lib/assistant/propose";
import {
  DATE_PATTERN,
  TIME_PATTERN,
  errorResult,
  today,
  whenLabel,
  type ToolHandler,
} from "./shared";
import type { Proposal, ToolDefinition } from "@/lib/assistant/types";

/**
 * Patient tools. Reads mirror the patient dashboard (same joins, same status
 * split); the three propose_* tools are the only writes, and each one returns a
 * signed proposal instead of touching the database. The confirm endpoint calls
 * the real server action, which re-validates the slot and the seat index.
 */

const scopeArg = z.object({
  scope: z.enum(["upcoming", "past"]).default("upcoming"),
});

const searchArg = z.object({
  query: z.string().trim().max(80).optional(),
});

const slotsArg = z.object({
  doctorId: z.number().int().positive(),
  date: z.string().regex(DATE_PATTERN),
});

const alternativesArg = z.object({
  doctorId: z.number().int().positive(),
  date: z.string().regex(DATE_PATTERN).optional(),
  time: z.string().regex(TIME_PATTERN).optional(),
});

const bookingArg = z.object({
  doctorId: z.number().int().positive(),
  date: z.string().regex(DATE_PATTERN),
  time: z.string().regex(TIME_PATTERN),
  reason: z.string().trim().max(300).optional(),
});

const rescheduleArg = z.object({
  appointmentId: z.number().int().positive(),
  date: z.string().regex(DATE_PATTERN),
  time: z.string().regex(TIME_PATTERN),
});

const appointmentIdArg = z.object({
  appointmentId: z.number().int().positive(),
});

async function doctorById(doctorId: number) {
  const db = getDb();
  const [doctor] = await db
    .select({
      id: doctors.id,
      fullName: doctors.fullName,
      specialization: doctors.specialization,
      consultationFee: doctors.consultationFee,
    })
    .from(doctors)
    .where(eq(doctors.id, doctorId))
    .limit(1);
  return doctor ?? null;
}

/** Free bookable items for one doctor on one date, computed the dashboard way. */
async function offersOn(doctorId: number, date: string) {
  const blocks = await blocksForDoctor(doctorId);
  const taken = await takenSeatsByTime({ doctorId, dateFrom: date, dateTo: date });
  return offersFor({
    blocks,
    date,
    takenSeats: taken.get(date) ?? new Map<string, number>(),
    now: clinicNow(),
  });
}

function proposalFrom(
  signed: { token: string; id: string; expiresAt: number },
  action: Proposal["action"],
  title: string,
  summary: string,
  details: string[],
): Proposal {
  return {
    id: signed.id,
    action,
    title,
    summary,
    details,
    token: signed.token,
    expiresAt: signed.expiresAt,
  };
}

export const patientDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "my_appointments",
      description:
        "The patient's own visits: upcoming live bookings (including a visit waiting for a new time), or past and cancelled ones. Use before answering anything about 'my appointments'.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["upcoming", "past"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_doctors",
      description:
        "Search the doctor directory by name or specialization. Returns id, fee, experience and specialization; use the id in every later slot or booking call.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name or specialization; omit to list doctors" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "available_slots",
      description:
        "What is actually bookable for one doctor on one date, with free seats per slot. Always call this before proposing a booking the patient has not already picked from a listing.",
      parameters: {
        type: "object",
        properties: {
          doctorId: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["doctorId", "date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_alternatives",
      description:
        "Free slots near a desired time for the same doctor (same day first, then the next week). Use when the wanted slot is full or does not exist.",
      parameters: {
        type: "object",
        properties: {
          doctorId: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD; the day to look around" },
          time: { type: "string", description: "HH:MM; the time to move away from" },
        },
        required: ["doctorId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_booking",
      description:
        "Prepare a booking. Does NOT book: returns a confirmation card the patient must tap Confirm on. Verify the slot with available_slots first.",
      parameters: {
        type: "object",
        properties: {
          doctorId: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string", description: "HH:MM, a time returned by available_slots" },
          reason: { type: "string", description: "Optional visit reason in the patient's words" },
        },
        required: ["doctorId", "date", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_reschedule",
      description:
        "Prepare a move of one of the patient's live visits to a new slot. Does NOT move it: returns a confirmation card. Verify the new slot with available_slots first.",
      parameters: {
        type: "object",
        properties: {
          appointmentId: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string", description: "HH:MM" },
        },
        required: ["appointmentId", "date", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_cancel",
      description:
        "Prepare a cancellation of one of the patient's live visits. Does NOT cancel: returns a confirmation card. The refund policy is applied by the real action.",
      parameters: {
        type: "object",
        properties: {
          appointmentId: { type: "number" },
        },
        required: ["appointmentId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "my_payments_and_refunds",
      description:
        "The patient's payment rows with their refund status. Use for 'did my refund come', 'what did I pay', 'is payment pending'.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "my_prescriptions",
      description:
        "Aftercare notes the patient's own doctors left on completed visits. This is the only tool that returns aftercare text; never read it out unless the patient asked about their prescriptions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export const patientHandlers: Record<string, ToolHandler> = {
  my_appointments: async (args, ctx) => {
    const parsed = scopeArg.safeParse(args ?? {});
    const scope = parsed.success ? parsed.data.scope : "upcoming";
    const db = getDb();

    const rows = await db
      .select({
        id: appointments.id,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
        status: appointments.status,
        seatNumber: appointments.seatNumber,
        doctorName: doctors.fullName,
        specialization: doctors.specialization,
        schedulingType: availability.schedulingType,
        windowEnd: availability.endTime,
        paymentStatus: payments.status,
        clinicMoved: appointments.clinicMoved,
      })
      .from(appointments)
      .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
      .leftJoin(availability, eq(appointments.availabilityId, availability.id))
      .leftJoin(payments, eq(payments.appointmentId, appointments.id))
      .where(eq(appointments.patientId, ctx.profileId))
      .orderBy(asc(appointments.appointmentDate), asc(appointments.appointmentTime));

    const nowDate = today();
    const isLive = (row: (typeof rows)[number]) =>
      row.status === "needs_rebooking" || (row.status === "booked" && row.date >= nowDate);

    const upcoming = rows.filter(isLive);
    const past = rows.filter((row) => !isLive(row)).reverse();
    const list = (scope === "upcoming" ? upcoming : past).slice(0, scope === "upcoming" ? 20 : 10);

    return {
      result: {
        scope,
        count: list.length,
        appointments: list.map((row) => ({
          id: row.id,
          doctorName: row.doctorName,
          specialization: row.specialization,
          date: row.date,
          time: row.time,
          when: whenLabel(row),
          status: row.status,
          paymentStatus: row.paymentStatus,
          movedByClinic: row.clinicMoved,
        })),
      },
    };
  },

  search_doctors: async (args) => {
    const parsed = searchArg.safeParse(args ?? {});
    const term = parsed.success ? (parsed.data.query?.trim() ?? "") : "";
    const db = getDb();

    const rows = await db
      .select({
        id: doctors.id,
        fullName: doctors.fullName,
        specialization: doctors.specialization,
        experienceYears: doctors.experienceYears,
        consultationFee: doctors.consultationFee,
      })
      .from(doctors)
      .where(
        term
          ? or(
              ilike(doctors.fullName, `%${term}%`),
              ilike(doctors.specialization, `%${term}%`),
            )
          : undefined,
      )
      .limit(8);

    return {
      result: {
        query: term,
        doctors: rows.map((row) => ({
          id: row.id,
          name: row.fullName,
          specialization: row.specialization,
          experienceYears: row.experienceYears,
          fee: row.consultationFee,
        })),
      },
    };
  },

  available_slots: async (args) => {
    const parsed = slotsArg.safeParse(args ?? {});
    if (!parsed.success) return errorResult("I need a doctor id and a real date (YYYY-MM-DD).");

    const doctor = await doctorById(parsed.data.doctorId);
    if (!doctor) return errorResult("That doctor could not be found.");

    const offers = (await offersOn(doctor.id, parsed.data.date)).filter(
      (offer) => offer.free > 0,
    );

    return {
      result: {
        doctor: { id: doctor.id, name: doctor.fullName, specialization: doctor.specialization },
        date: parsed.data.date,
        slots: offers.map((offer) => ({
          time: offer.time,
          endTime: offer.endTime,
          availabilityId: offer.availabilityId,
          schedulingType: offer.schedulingType,
          free: offer.free,
        })),
      },
    };
  },

  suggest_alternatives: async (args) => {
    const parsed = alternativesArg.safeParse(args ?? {});
    if (!parsed.success) return errorResult("I need a valid doctor id.");

    const doctor = await doctorById(parsed.data.doctorId);
    if (!doctor) return errorResult("That doctor could not be found.");

    const now = clinicNow();
    const dates = [
      ...new Set([
        ...(parsed.data.date ? [parsed.data.date] : []),
        ...upcomingDays(8).map((day) => day.date),
      ]),
    ]
      .filter((date) => date >= now.date)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 9);

    const slots: Array<{
      date: string;
      time: string;
      endTime: string | null;
      availabilityId: number;
      free: number;
    }> = [];

    for (const date of dates) {
      for (const offer of await offersOn(doctor.id, date)) {
        if (offer.free <= 0) continue;
        if (
          parsed.data.date === date &&
          parsed.data.time !== undefined &&
          offer.time === parsed.data.time
        ) {
          continue;
        }
        slots.push({
          date,
          time: offer.time,
          endTime: offer.endTime,
          availabilityId: offer.availabilityId,
          free: offer.free,
        });
      }
      if (slots.length >= 6) break;
    }

    return {
      result: {
        doctor: { id: doctor.id, name: doctor.fullName },
        alternatives: slots.slice(0, 6),
      },
    };
  },

  propose_booking: async (args, ctx) => {
    const parsed = bookingArg.safeParse(args ?? {});
    if (!parsed.success) {
      return errorResult("I need a doctor id, a real date and a time (HH:MM) to prepare a booking.");
    }

    const doctor = await doctorById(parsed.data.doctorId);
    if (!doctor) return errorResult("That doctor could not be found.");

    const offers = await offersOn(doctor.id, parsed.data.date);
    const match = offers.find(
      (offer) => offer.time === parsed.data.time && offer.free > 0,
    );
    if (!match) {
      return errorResult(
        "That slot is not free right now. Call suggest_alternatives with the same doctor and I will list what is open.",
      );
    }

    const signed = await signProposal({
      action: "book",
      args: {
        doctorId: doctor.id,
        availabilityId: match.availabilityId,
        date: parsed.data.date,
        time: parsed.data.time,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      },
      userId: ctx.userId,
      role: ctx.role,
    });

    const summary = `Book ${doctor.fullName} (${doctor.specialization}) for ${whenLabel({
      date: parsed.data.date,
      time: parsed.data.time,
      schedulingType: match.schedulingType,
      windowEnd: match.endTime,
    })}.`;

    return {
      result: {
        ok: true,
        proposalId: signed.id,
        summary,
        note: "A confirmation card is now on screen. The booking is written only after the patient taps Confirm.",
      },
      proposal: proposalFrom(signed, "book", "Confirm booking", summary, [
        doctor.fullName,
        doctor.specialization,
        whenLabel({
          date: parsed.data.date,
          time: parsed.data.time,
          schedulingType: match.schedulingType,
          windowEnd: match.endTime,
        }),
        `Fee ₹${doctor.consultationFee}`,
      ]),
    };
  },

  propose_reschedule: async (args, ctx) => {
    const parsed = rescheduleArg.safeParse(args ?? {});
    if (!parsed.success) {
      return errorResult("I need the appointment id, the new date and the new time.");
    }

    const db = getDb();
    const [appointment] = await db
      .select({
        id: appointments.id,
        doctorId: appointments.doctorId,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
        status: appointments.status,
        doctorName: doctors.fullName,
        schedulingType: availability.schedulingType,
        windowEnd: availability.endTime,
      })
      .from(appointments)
      .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
      .leftJoin(availability, eq(appointments.availabilityId, availability.id))
      .where(
        and(
          eq(appointments.id, parsed.data.appointmentId),
          eq(appointments.patientId, ctx.profileId),
        ),
      )
      .limit(1);

    if (!appointment) return errorResult("That appointment is not yours.");
    if (appointment.status !== "booked" && appointment.status !== "needs_rebooking") {
      return errorResult("Only a live appointment can be moved.");
    }
    if (
      appointment.status === "booked" &&
      appointment.date === parsed.data.date &&
      appointment.time === parsed.data.time
    ) {
      return errorResult("That is already the current slot.");
    }

    const offers = await offersOn(appointment.doctorId, parsed.data.date);
    const match = offers.find(
      (offer) => offer.time === parsed.data.time && offer.free > 0,
    );
    if (!match) {
      return errorResult(
        "That new time is not free. Ask me for alternatives and I will list open slots.",
      );
    }

    const signed = await signProposal({
      action: "reschedule",
      args: {
        appointmentId: appointment.id,
        date: parsed.data.date,
        time: parsed.data.time,
      },
      userId: ctx.userId,
      role: ctx.role,
    });

    const from = whenLabel(appointment);
    const to = whenLabel({
      date: parsed.data.date,
      time: parsed.data.time,
      schedulingType: match.schedulingType,
      windowEnd: match.endTime,
    });
    const summary = `Move the ${appointment.doctorName} visit from ${from} to ${to}.`;

    return {
      result: {
        ok: true,
        proposalId: signed.id,
        summary,
        note: "A confirmation card is now on screen. The move happens only after the patient taps Confirm.",
      },
      proposal: proposalFrom(signed, "reschedule", "Confirm reschedule", summary, [
        appointment.doctorName,
        `From: ${from}`,
        `To: ${to}`,
      ]),
    };
  },

  propose_cancel: async (args, ctx) => {
    const parsed = appointmentIdArg.safeParse(args ?? {});
    if (!parsed.success) return errorResult("I need the appointment id to prepare a cancellation.");

    const db = getDb();
    const [appointment] = await db
      .select({
        id: appointments.id,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
        status: appointments.status,
        doctorName: doctors.fullName,
        schedulingType: availability.schedulingType,
        windowEnd: availability.endTime,
        paymentStatus: payments.status,
      })
      .from(appointments)
      .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
      .leftJoin(availability, eq(appointments.availabilityId, availability.id))
      .leftJoin(payments, eq(payments.appointmentId, appointments.id))
      .where(
        and(
          eq(appointments.id, parsed.data.appointmentId),
          eq(appointments.patientId, ctx.profileId),
        ),
      )
      .limit(1);

    if (!appointment) return errorResult("That appointment is not yours.");
    if (appointment.status !== "booked" && appointment.status !== "needs_rebooking") {
      return errorResult("Only a live appointment can be cancelled.");
    }

    const signed = await signProposal({
      action: "cancel",
      args: { appointmentId: appointment.id },
      userId: ctx.userId,
      role: ctx.role,
    });

    const when = whenLabel(appointment);
    const paymentLine =
      appointment.paymentStatus === "succeeded"
        ? "Paid online — the refund policy is applied when you confirm."
        : appointment.paymentStatus === "pending"
          ? "Payment still pending."
          : "Fee payable at the clinic.";
    const summary = `Cancel the ${appointment.doctorName} visit on ${when}.`;

    return {
      result: {
        ok: true,
        proposalId: signed.id,
        summary,
        note: "A confirmation card is now on screen. The cancellation happens only after the patient taps Confirm.",
      },
      proposal: proposalFrom(signed, "cancel", "Confirm cancellation", summary, [
        appointment.doctorName,
        when,
        paymentLine,
      ]),
    };
  },

  my_payments_and_refunds: async (_args, ctx) => {
    const db = getDb();
    const rows = await db
      .select({
        appointmentId: payments.appointmentId,
        doctorName: doctors.fullName,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
        amount: payments.amount,
        currency: payments.currency,
        status: payments.status,
        provider: payments.provider,
        refundAmount: refunds.amount,
        refundStatus: refunds.status,
        refundNote: refunds.note,
      })
      .from(payments)
      .innerJoin(appointments, eq(payments.appointmentId, appointments.id))
      .innerJoin(doctors, eq(payments.doctorId, doctors.id))
      .leftJoin(refunds, eq(refunds.paymentId, payments.id))
      .where(eq(payments.patientId, ctx.profileId))
      .orderBy(desc(payments.createdAt))
      .limit(12);

    return {
      result: {
        payments: rows.map((row) => ({
          appointmentId: row.appointmentId,
          doctorName: row.doctorName,
          dateLabel: `${formatDate(row.date)} ${formatTime(row.time)}`,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          provider: row.provider,
          refund:
            row.refundAmount === null
              ? null
              : {
                  amount: row.refundAmount,
                  status: row.refundStatus,
                  note: row.refundNote,
                },
        })),
      },
    };
  },

  my_prescriptions: async (_args, ctx) => {
    const db = getDb();
    const rows = await db
      .select({
        appointmentId: appointments.id,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
        doctorName: doctors.fullName,
        aftercare: visitNotes.aftercare,
        followUpDays: visitNotes.followUpDays,
      })
      .from(visitNotes)
      .innerJoin(appointments, eq(visitNotes.appointmentId, appointments.id))
      .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
      .where(
        and(
          eq(appointments.patientId, ctx.profileId),
          eq(appointments.status, "completed"),
          isNotNull(visitNotes.aftercare),
        ),
      )
      .orderBy(desc(appointments.appointmentDate))
      .limit(10);

    return {
      result: {
        prescriptions: rows.map((row) => ({
          appointmentId: row.appointmentId,
          doctorName: row.doctorName,
          dateLabel: `${formatDate(row.date)} ${formatTime(row.time)}`,
          aftercare: row.aftercare,
          followUpDays: row.followUpDays,
        })),
      },
    };
  },
};
