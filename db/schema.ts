import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["patient", "doctor"]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "booked",
  "completed",
  "cancelled",
]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const patients = pgTable("patients", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  phone: text("phone"),
  dateOfBirth: text("date_of_birth"),
  gender: text("gender"),
});

export const doctors = pgTable("doctors", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  specialization: text("specialization").notNull(),
  experienceYears: integer("experience_years").notNull().default(0),
  qualification: text("qualification"),
  consultationFee: numeric("consultation_fee", { precision: 10, scale: 2 })
    .notNull()
    .default("0"),
  bio: text("bio"),
});

export const availability = pgTable("availability", {
  id: serial("id").primaryKey(),
  doctorId: integer("doctor_id")
    .notNull()
    .references(() => doctors.id, { onDelete: "cascade" }),
  /** 0 = Sunday ... 6 = Saturday */
  dayOfWeek: integer("day_of_week").notNull(),
  /** "09:00" */
  startTime: text("start_time").notNull(),
  /** "13:00" */
  endTime: text("end_time").notNull(),
  slotMinutes: integer("slot_minutes").notNull().default(30),
  isActive: boolean("is_active").notNull().default(true),
});

export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id")
    .notNull()
    .references(() => patients.id, { onDelete: "cascade" }),
  doctorId: integer("doctor_id")
    .notNull()
    .references(() => doctors.id, { onDelete: "cascade" }),
  availabilityId: integer("availability_id").references(() => availability.id, {
    onDelete: "set null",
  }),
  /** "2026-10-28" */
  appointmentDate: text("appointment_date").notNull(),
  /** "10:30" */
  appointmentTime: text("appointment_time").notNull(),
  status: appointmentStatusEnum("status").notNull().default("booked"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type Doctor = typeof doctors.$inferSelect;
export type Patient = typeof patients.$inferSelect;
export type Availability = typeof availability.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type AppointmentStatus = Appointment["status"];
