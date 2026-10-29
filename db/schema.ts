import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["patient", "doctor"]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "booked",
  "completed",
  "cancelled",
  "no_show",
]);
export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "succeeded",
  "failed",
  "partially_refunded",
  "refunded",
]);
export const refundStatusEnum = pgEnum("refund_status", [
  "pending",
  "processing",
  "completed",
  "failed",
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

export const appointments = pgTable(
  "appointments",
  {
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
  },
  (table) => [
    /**
     * A doctor cannot have two active bookings for the same slot. Cancelled
     * appointments are excluded so the slot becomes bookable again.
     */
    uniqueIndex("appointments_booked_slot_unique")
      .on(table.doctorId, table.appointmentDate, table.appointmentTime)
      .where(sql`${table.status} = 'booked'`),
    /** Dashboards filter a doctor's or patient's appointments by date range. */
    index("appointments_doctor_date_idx").on(table.doctorId, table.appointmentDate),
    index("appointments_patient_date_idx").on(table.patientId, table.appointmentDate),
  ],
);

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  appointmentId: integer("appointment_id")
    .notNull()
    .unique()
    .references(() => appointments.id, { onDelete: "cascade" }),
  patientId: integer("patient_id").notNull(),
  doctorId: integer("doctor_id").notNull(),
  /** Consultation fee captured at booking time, in the appointment's currency. */
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  status: paymentStatusEnum("status").notNull().default("pending"),
  /** `razorpay` for online checkout, `manual` when the fee is collected at the clinic. */
  provider: text("provider").notNull().default("razorpay"),
  providerOrderId: text("provider_order_id"),
  providerPaymentId: text("provider_payment_id"),
  failureReason: text("failure_reason"),
  /**
   * When a pending online payment stops holding the appointment slot. Null for
   * manual payments, which are settled at the clinic and never expire.
   */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** Set when money was captured but could not be honoured (slot already gone). */
  requiresRefund: boolean("requires_refund").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (table) => [
  /** Webhooks look a payment up by the provider's order id. */
  index("payments_provider_order_idx").on(table.providerOrderId),
  /** The expiry sweeper scans pending payments that are past their hold. */
  index("payments_status_expiry_idx").on(table.status, table.expiresAt),
  index("payments_patient_idx").on(table.patientId),
]);

export type User = typeof users.$inferSelect;
export type Doctor = typeof doctors.$inferSelect;
export type Patient = typeof patients.$inferSelect;
export type Availability = typeof availability.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type AppointmentStatus = Appointment["status"];
export type Payment = typeof payments.$inferSelect;
export type PaymentStatus = Payment["status"];

/**
 * One row per refund attempt. A policy-driven cancellation creates exactly one
 * refund, protected from duplicates by `idempotencyKey`; a failed refund is
 * retried on the same row so history never shows phantom refunds.
 */
export const refunds = pgTable("refunds", {
  id: serial("id").primaryKey(),
  paymentId: integer("payment_id")
    .notNull()
    .references(() => payments.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  status: refundStatusEnum("status").notNull().default("pending"),
  /** Machine-readable policy reason, e.g. `cancelled_before_24h`. */
  reason: text("reason").notNull(),
  /** Human-readable explanation shown to the patient. */
  note: text("note"),
  /** Who triggered the refund: `patient`, `clinic` or `system`. */
  requestedBy: text("requested_by").notNull().default("system"),
  provider: text("provider").notNull(),
  providerRefundId: text("provider_refund_id"),
  failureReason: text("failure_reason"),
  /** Unique per payment+policy decision; makes duplicate requests harmless. */
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  /** Webhooks arrive with the provider's refund id, not ours. */
  index("refunds_provider_refund_idx").on(table.providerRefundId),
  index("refunds_payment_idx").on(table.paymentId),
]);

export type Refund = typeof refunds.$inferSelect;
export type RefundStatus = Refund["status"];

export const reminderKindEnum = pgEnum("reminder_kind", ["24h", "1h"]);

/**
 * Ledger of appointment reminders already sent. Reminders are never scheduled
 * per-appointment jobs: a sweep derives what is due from live appointment state
 * (booked visits only, so a cancellation stops its own reminder), and this
 * table's unique constraint is what keeps any number of concurrent sweeps from
 * sending the same reminder twice.
 */
export const reminders = pgTable("reminders", {
  id: serial("id").primaryKey(),
  appointmentId: integer("appointment_id")
    .notNull()
    .references(() => appointments.id, { onDelete: "cascade" }),
  kind: reminderKindEnum("kind").notNull(),
  /** Where the reminder was delivered, kept for audit. */
  sentTo: text("sent_to"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("reminders_appointment_kind_unique").on(table.appointmentId, table.kind),
]);

export type Reminder = typeof reminders.$inferSelect;
export type ReminderKind = Reminder["kind"];
