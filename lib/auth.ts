import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  MAX_BLOCK_DATES,
  MAX_CAPACITY,
  SCHEDULING_TYPES,
  type SchedulingType,
} from "@/lib/schedule";
import { toMinutes } from "@/lib/slots";

export const signUpSchema = z.object({
  name: z.string().trim().min(2, "Please enter your full name"),
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.enum(["patient", "doctor"]),
  specialization: z.string().trim().optional(),
  experienceYears: z.string().trim().optional(),
  consultationFee: z.string().trim().optional(),
  phone: z.string().trim().optional(),
});

export const signInSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
});

export const resetPasswordSchema = z
  .object({
    /** The one credential inside the emailed link, carried here hidden. */
    token: z.string().min(1, "This reset link is incomplete — request a fresh one"),
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const bookingSchema = z.object({
  doctorId: z.coerce.number().int().positive(),
  availabilityId: z.coerce.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid date"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Pick a valid time"),
  reason: z.string().trim().max(300).optional(),
});

const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a valid time like 09:30");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid date");

/**
 * A schedule block as the doctor form submits it.
 *
 * The block is weekly or date-based, never both: a weekly block names a
 * weekday, a date-based block lists the dates it opens on. One listed date
 * makes the block non-recurring; several make it a recurring series.
 *
 * The visit length belongs to a wave only — a stream books its window as one
 * start–end item, so the field is not part of its contract.
 */
export const availabilitySchema = z
  .object({
    schedulingType: z.enum(SCHEDULING_TYPES),
    recurrence: z.enum(["weekly", "dates"]),
    dayOfWeek: z.coerce.number().int().min(0, "Pick a day").max(6, "Pick a day").optional(),
    dates: z.array(isoDate).max(MAX_BLOCK_DATES, `Pick at most ${MAX_BLOCK_DATES} dates`),
    startTime: clockTime,
    endTime: clockTime,
    slotMinutes: z.coerce
      .number()
      .int()
      .refine(
        (value) => [15, 30, 45, 60].includes(value),
        "Visit length must be 15, 30, 45 or 60 minutes",
      )
      .optional(),
    capacity: z.coerce
      .number()
      .int()
      .min(1, "At least one patient")
      .max(MAX_CAPACITY, `At most ${MAX_CAPACITY} patients`),
  })
  .superRefine((value, ctx) => {
    // Equal bounds are allowed and mean "closed": the block stays published,
    // keeps its history, and offers no slots. Only a backwards window is bad.
    if (value.startTime > value.endTime) {
      ctx.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time cannot be before the start time",
      });
    }
    if (value.recurrence === "weekly" && value.dayOfWeek === undefined) {
      ctx.addIssue({ code: "custom", path: ["dayOfWeek"], message: "Pick a day" });
    }
    if (value.recurrence === "dates" && value.dates.length === 0) {
      ctx.addIssue({ code: "custom", path: ["dates"], message: "Pick at least one date" });
    }
    if (value.schedulingType === "wave" && value.slotMinutes === undefined) {
      ctx.addIssue({ code: "custom", path: ["slotMinutes"], message: "Pick a visit length" });
    }
    if (value.schedulingType === "stream" && value.startTime < value.endTime) {
      // A stream takes one patient per minute of window at the tightest, so a
      // window shorter than its capacity could never hold them all. A closed
      // window is the exception: it holds nobody, and its stored capacity is
      // only the shape it would have if reopened.
      const windowMinutes = toMinutes(value.endTime) - toMinutes(value.startTime);
      if (value.capacity > windowMinutes) {
        ctx.addIssue({
          code: "custom",
          path: ["capacity"],
          message: "A stream cannot hold more patients than the window has minutes",
        });
      }
    }
  });

/**
 * An edit to a published block's window: the block, its new bounds, and its
 * new capacity.
 *
 * The scheduling type and visit length are fixed when the block is created —
 * reshaping a wave's slot grid could strand booked visits mid-grid — so only
 * the window bounds and the capacity are elastic. The type is passed in
 * because the block keeps the one it was published with.
 */
export function availabilityEditSchema(schedulingType: SchedulingType) {
  return z
    .object({
      availabilityId: z.coerce.number().int().positive(),
      startTime: clockTime,
      endTime: clockTime,
      capacity: z.coerce
        .number()
        .int()
        .min(1, "At least one patient")
        .max(MAX_CAPACITY, `At most ${MAX_CAPACITY} patients`),
    })
    .superRefine((value, ctx) => {
      // Equal bounds close the window. That is a legal edit: every not-started
      // booking is displaced, and the block keeps its published history.
      if (value.startTime > value.endTime) {
        ctx.addIssue({
          code: "custom",
          path: ["endTime"],
          message: "End time cannot be before the start time",
        });
      }
      if (schedulingType === "stream" && value.startTime < value.endTime) {
        const windowMinutes = toMinutes(value.endTime) - toMinutes(value.startTime);
        if (value.capacity > windowMinutes) {
          ctx.addIssue({
            code: "custom",
            path: ["capacity"],
            message: "A stream cannot hold more patients than the window has minutes",
          });
        }
      }
    });
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

/** Turns a ZodError into a flat field -> message map for form rendering. */
export function fieldErrors(error: z.ZodError) {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
