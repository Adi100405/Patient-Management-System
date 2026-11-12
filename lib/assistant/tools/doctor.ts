import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { appointments, availability, patients } from "@/db/schema";
import { blocksForDoctor } from "@/lib/availability";
import { blocksConflict, offersFor, windowIsClosed, type ScheduleBlock } from "@/lib/schedule";
import { takenSeatsByTime } from "@/lib/seats";
import { clinicClock, clinicNow, upcomingDays } from "@/lib/slots";
import { DATE_PATTERN, errorResult, maskPhone, today, whenLabel, type ToolHandler } from "./shared";
import type { AssistantContext, ToolDefinition } from "@/lib/assistant/types";

/**
 * Doctor tools. Every query shape mirrors the doctor dashboard: the same joins,
 * the same FIFO ordering, the same status filters. Nothing here invents a
 * second source of truth for the schedule.
 */

const dateArg = z.object({
  date: z.string().regex(DATE_PATTERN).optional(),
});

const appointmentIdArg = z.object({
  appointmentId: z.number().int().positive(),
});

function blockLabel(block: ScheduleBlock): string {
  const days =
    block.dayOfWeek !== null
      ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
          block.dayOfWeek
        ] ?? `weekday ${block.dayOfWeek}`
      : block.dates.length === 1
        ? block.dates[0]
        : `${block.dates.length} dates`;
  const state = windowIsClosed(block) ? "closed" : "open";
  return `#${block.id} ${block.schedulingType} ${block.startTime}-${block.endTime} ${days} (${state})`;
}

/** The dashboard's schedule join for one calendar date. */
async function appointmentsOn(ctx: AssistantContext, date: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: appointments.id,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      status: appointments.status,
      seatNumber: appointments.seatNumber,
      queueSince: appointments.queueSince,
      patientName: patients.fullName,
      patientPhone: patients.phone,
      schedulingType: availability.schedulingType,
      windowEnd: availability.endTime,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .leftJoin(availability, eq(appointments.availabilityId, availability.id))
    .where(
      and(
        eq(appointments.doctorId, ctx.profileId),
        eq(appointments.appointmentDate, date),
      ),
    )
    .orderBy(
      asc(appointments.appointmentTime),
      asc(appointments.queueSince),
      asc(appointments.id),
    );

  const queuePlace = new Map<string, number>();
  return rows.map((row) => {
    let position: number | null = null;
    if (row.status === "booked") {
      const next = (queuePlace.get(row.time) ?? 0) + 1;
      queuePlace.set(row.time, next);
      position = next;
    }
    return {
      id: row.id,
      patientName: row.patientName,
      // PHI shaping: the assistant can confirm the number on file, never read it.
      patientPhone: maskPhone(row.patientPhone),
      when: whenLabel(row),
      time: row.time,
      status: row.status,
      seatNumber: row.seatNumber,
      queuePosition: position,
    };
  });
}

/** The dashboard's four count filters, one row. */
async function statsFor(ctx: AssistantContext) {
  const db = getDb();
  const instant = new Date();
  const now = clinicNow(instant);
  const nowTime = clinicClock(instant);

  const [stats] = await db
    .select({
      today: sql<number>`count(*) filter (where ${appointments.status} = 'booked' and ${appointments.appointmentDate} = ${now.date})::int`,
      upcoming: sql<number>`count(*) filter (where ${appointments.status} = 'booked' and (${appointments.appointmentDate} > ${now.date} or (${appointments.appointmentDate} = ${now.date} and ${appointments.appointmentTime} > ${nowTime})))::int`,
      patientsSeen: sql<number>`count(distinct ${appointments.patientId}) filter (where ${appointments.status} = 'completed')::int`,
      noShows: sql<number>`count(*) filter (where ${appointments.status} = 'no_show')::int`,
      completed: sql<number>`count(*) filter (where ${appointments.status} = 'completed')::int`,
      cancelled: sql<number>`count(*) filter (where ${appointments.status} = 'cancelled')::int`,
    })
    .from(appointments)
    .where(eq(appointments.doctorId, ctx.profileId));

  return { date: now.date, ...stats };
}

/**
 * Free offers over a set of dates, in the dashboard's own slot vocabulary.
 * Shared by "next free slot" and "suggest a move".
 */
async function freeOffers(ctx: AssistantContext, dates: readonly string[]) {
  if (dates.length === 0) return [];
  const ordered = [...dates].sort((a, b) => a.localeCompare(b));
  const blocks = await blocksForDoctor(ctx.profileId);
  const taken = await takenSeatsByTime({
    doctorId: ctx.profileId,
    dateFrom: ordered[0]!,
    dateTo: ordered[ordered.length - 1]!,
  });
  const now = clinicNow();
  const offers: Array<{
    date: string;
    time: string;
    endTime: string | null;
    availabilityId: number;
    schedulingType: string;
    free: number;
  }> = [];

  for (const date of ordered) {
    if (date < now.date) continue;
    for (const offer of offersFor({
      blocks,
      date,
      takenSeats: taken.get(date) ?? new Map<string, number>(),
      now,
    })) {
      if (offer.free <= 0) continue;
      offers.push({
        date,
        time: offer.time,
        endTime: offer.endTime,
        availabilityId: offer.availabilityId,
        schedulingType: offer.schedulingType,
        free: offer.free,
      });
    }
  }

  return offers;
}

export const doctorDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "appointments_for_date",
      description:
        "The doctor's own schedule for one date: every visit with its patient, status and queue place. Defaults to today. Use this to answer 'who is coming in', 'what does my day look like'.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD; omit for today" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "appointment_stats",
      description:
        "The dashboard counters: visits booked (confirmed) today, upcoming live bookings, distinct patients seen, no-shows, and lifetime completed and cancelled totals, for this doctor only.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "availability_overview",
      description:
        "Every schedule window this doctor publishes, with day, hours, capacity and whether it is closed. Use before answering about consulting hours or editing availability.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "detect_conflicts",
      description:
        "Pairwise overlap check over this doctor's published windows, using the same rule the edit form refuses on. Returns an empty list when the schedule is clean.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_reschedule_slots",
      description:
        "Free slots near one of the doctor's bookings, for offering a displaced patient a new time. Same day first, then the next week.",
      parameters: {
        type: "object",
        properties: {
          appointmentId: { type: "number", description: "The booking to move" },
        },
        required: ["appointmentId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "next_available_slot",
      description:
        "The first free bookable slots over the next week, so the doctor can quote one without scanning the schedule.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "today_summary",
      description:
        "One call for 'how is today going': the counters plus the full visit list for today.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export const doctorHandlers: Record<string, ToolHandler> = {
  appointments_for_date: async (args, ctx) => {
    const parsed = dateArg.safeParse(args ?? {});
    if (!parsed.success) return errorResult("Use a real date in YYYY-MM-DD form.");
    const date = parsed.data.date ?? today();
    return { result: { date, appointments: await appointmentsOn(ctx, date) } };
  },

  appointment_stats: async (_args, ctx) => {
    return { result: await statsFor(ctx) };
  },

  availability_overview: async (_args, ctx) => {
    const blocks = await blocksForDoctor(ctx.profileId);
    return {
      result: {
        windows: blocks.map((block) => ({
          id: block.id,
          type: block.schedulingType,
          dayOfWeek: block.dayOfWeek,
          dates: block.dates,
          startTime: block.startTime,
          endTime: block.endTime,
          slotMinutes: block.slotMinutes,
          capacity: block.capacity,
          closed: windowIsClosed(block),
        })),
      },
    };
  },

  detect_conflicts: async (_args, ctx) => {
    const blocks = await blocksForDoctor(ctx.profileId);
    const conflicts: Array<{ window: string; overlapsWith: string }> = [];
    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        if (blocksConflict(blocks[i]!, blocks[j]!)) {
          conflicts.push({
            window: blockLabel(blocks[i]!),
            overlapsWith: blockLabel(blocks[j]!),
          });
        }
      }
    }
    return { result: { conflicts } };
  },

  suggest_reschedule_slots: async (args, ctx) => {
    const parsed = appointmentIdArg.safeParse(args ?? {});
    if (!parsed.success) return errorResult("I need a valid appointment id.");

    const db = getDb();
    const [appointment] = await db
      .select({
        id: appointments.id,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
        status: appointments.status,
        patientName: patients.fullName,
        schedulingType: availability.schedulingType,
        windowEnd: availability.endTime,
      })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(availability, eq(appointments.availabilityId, availability.id))
      .where(
        and(
          eq(appointments.id, parsed.data.appointmentId),
          eq(appointments.doctorId, ctx.profileId),
        ),
      )
      .limit(1);

    if (!appointment) return errorResult("That appointment is not on this doctor's schedule.");
    if (appointment.status !== "booked" && appointment.status !== "needs_rebooking") {
      return errorResult("Only a live appointment can be moved.");
    }

    const now = clinicNow();
    const dates = [
      ...new Set([
        appointment.date,
        ...upcomingDays(8).map((day) => day.date),
      ]),
    ]
      .filter((date) => date >= now.date)
      .slice(0, 9);

    const suggestions = (await freeOffers(ctx, dates)).filter(
      (offer) => !(offer.date === appointment.date && offer.time === appointment.time),
    );

    return {
      result: {
        appointment: {
          id: appointment.id,
          patientName: appointment.patientName,
          when: whenLabel(appointment),
          status: appointment.status,
        },
        suggestions: suggestions.slice(0, 6),
      },
    };
  },

  next_available_slot: async (_args, ctx) => {
    const slots = (await freeOffers(ctx, upcomingDays(8).map((day) => day.date))).slice(0, 3);
    return { result: { slots } };
  },

  today_summary: async (_args, ctx) => {
    const stats = await statsFor(ctx);
    return {
      result: { ...stats, appointments: await appointmentsOn(ctx, stats.date) },
    };
  },
};
