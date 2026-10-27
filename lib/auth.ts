import bcrypt from "bcryptjs";
import { z } from "zod";

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

export const availabilitySchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0, "Pick a day").max(6, "Pick a day"),
    startTime: clockTime,
    endTime: clockTime,
    slotMinutes: z.coerce
      .number()
      .int()
      .refine((value) => [15, 30, 45, 60].includes(value), "Slot length must be 15, 30, 45 or 60 minutes"),
  })
  .refine((value) => value.startTime < value.endTime, {
    message: "End time must be after the start time",
    path: ["endTime"],
  });

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
