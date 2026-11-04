import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["patient", "doctor"]);

/**
 * How a schedule block turns its window into bookable positions.
 *
 * Wave: a repeated visit slot, so the capacity counts patients per slot.
 * Stream: a continuous run of appointments, so the capacity counts patients
 * in the window and the window is divided into that many positions.
 */
export const schedulingTypeEnum = pgEnum("scheduling_type", ["wave", "stream"]);

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

/**
 * One schedule block: the window a doctor publishes, how it turns into
 * bookable positions, and when it applies.
 *
 * A block is either weekly or date-based, never both: a weekly block carries a
 * weekday and a date-based block carries rows in `availability_dates`. One date
 * in that list makes the block non-recurring; several make it a recurring
 * series.
 */
export const availability = pgTable(
  "availability",
  {
    id: serial("id").primaryKey(),
    doctorId: integer("doctor_id")
      .notNull()
      .references(() => doctors.id, { onDelete: "cascade" }),
    /** How the window turns into bookable positions. */
    schedulingType: schedulingTypeEnum("scheduling_type").notNull().default("wave"),
    /** 0 = Sunday ... 6 = Saturday. Null means the block follows an explicit date list. */
    dayOfWeek: integer("day_of_week"),
    /** "09:00" */
    startTime: text("start_time").notNull(),
    /** "13:00" */
    endTime: text("end_time").notNull(),
    /**
     * Wave: the length of one visit, so the next patient starts when it ends.
     * Stream: the derived distance between two positions, which is the window
     * divided by the capacity — a stream never asks the doctor for a length.
     */
    slotMinutes: integer("slot_minutes").notNull().default(30),
    /** Wave: patients per slot. Stream: patients in the window. */
    capacity: integer("capacity").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    check("availability_capacity_positive", sql`${table.capacity} >= 1`),
  ],
);

/**
 * The explicit dates a date-based block opens on. A weekly block has no rows
 * here; a block with one row is non-recurring and a block with several is a
 * recurring series.
 */
export const availabilityDates = pgTable(
  "availability_dates",
  {
    availabilityId: integer("availability_id")
      .notNull()
      .references(() => availability.id, { onDelete: "cascade" }),
    /** "2026-11-12" */
    date: text("date").notNull(),
  },
  (table) => [
    uniqueIndex("availability_dates_block_date_unique").on(table.availabilityId, table.date),
    index("availability_dates_date_idx").on(table.date),
  ],
);

export type AvailabilityDate = typeof availabilityDates.$inferSelect;

/**
 * The partial unique index that enforces capacity.
 *
 * Seats are numbered from one within a slot, so the index is what stops a
 * doctor from seeing more patients in a wave slot than the slot holds. Cancelled
 * appointments leave the index, so a cancelled booking returns its seat to the
 * pool without anybody having to release it by hand.
 */
export const BOOKED_SEAT_INDEX = "appointments_booked_seat_unique";

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
    /**
     * Which seat in the slot this patient holds, numbered from one. A wave
     * slot has as many seats as its capacity; a stream position has exactly
     * one.
     */
    seatNumber: integer("seat_number").notNull().default(1),
    status: appointmentStatusEnum("status").notNull().default("booked"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * A doctor cannot have two active bookings in the same seat. Cancelled
     * appointments are excluded so the seat becomes bookable again.
     */
    uniqueIndex(BOOKED_SEAT_INDEX)
      .on(table.doctorId, table.appointmentDate, table.appointmentTime, table.seatNumber)
      .where(sql`${table.status} = 'booked'`),
    check("appointments_seat_positive", sql`${table.seatNumber} >= 1`),
    /** Dashboards filter a doctor's or patient's appointments by date range. */
    index("appointments_doctor_date_idx").on(table.doctorId, table.appointmentDate),
    index("appointments_patient_date_idx").on(table.patientId, table.appointmentDate),
  ],
);

/**
 * Doctor-authored aftercare for a completed visit. One row per appointment,
 * written at the moment the doctor resolves the visit.
 *
 * `aftercare` is medical content (PHI): it is shown **only** on the patient's
 * own dashboard and is never copied into an email or mobile message. The
 * follow-up loop links to it, it does not quote it.
 *
 * `followUpDays` is the doctor's recommendation ("come back in two weeks"). Null
 * means no follow-up was advised, and therefore no follow-up prompt is sent;
 * the loop stays silent rather than nagging on a guess.
 */
export const visitNotes = pgTable("visit_notes", {
  appointmentId: integer("appointment_id")
    .primaryKey()
    .references(() => appointments.id, { onDelete: "cascade" }),
  aftercare: text("aftercare"),
  followUpDays: integer("follow_up_days"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type VisitNote = typeof visitNotes.$inferSelect;

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

export const careFollowUpKindEnum = pgEnum("care_follow_up_kind", [
  "visit_thanks",
  "follow_up_prompt",
]);

/**
 * Ledger of post-visit care messages already sent. Same shape and rationale as
 * `reminders`: the sweep derives what is due from live appointment state
 * (completed visits only), and this table's unique (appointment_id, kind) index
 * is what keeps overlapping sweeps from sending the same message twice.
 */
export const careFollowUps = pgTable("care_follow_ups", {
  id: serial("id").primaryKey(),
  appointmentId: integer("appointment_id")
    .notNull()
    .references(() => appointments.id, { onDelete: "cascade" }),
  kind: careFollowUpKindEnum("kind").notNull(),
  /** Where the message was delivered, kept for audit. */
  sentTo: text("sent_to"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("care_follow_ups_appointment_kind_unique").on(table.appointmentId, table.kind),
]);

export type CareFollowUp = typeof careFollowUps.$inferSelect;
export type CareFollowUpKind = CareFollowUp["kind"];

/**
 * The channels a ledger row can carry.
 *
 * `whatsapp` is legacy: the WhatsApp transport was removed, so no new row can
 * carry it, but rows written before the removal still do. The value stays in
 * the enum so that history keeps reading back — dropping it would need a
 * migration that rewrites rows the ledger exists to preserve.
 */
export const notificationChannelEnum = pgEnum("notification_channel", ["email", "sms", "whatsapp"]);
export const notificationStatusEnum = pgEnum("notification_status", [
  "queued",
  "sent",
  "failed",
]);

/**
 * Durable audit ledger for every notification the app tries to send.
 *
 * One row is written before the provider is called, so a send that never
 * returns still leaves evidence behind. `idempotencyKey` is what makes a
 * duplicate event (a webhook delivered twice, a double-clicked button, a
 * retried server action) harmless: the unique constraint claims the message
 * once, and every later attempt finds the existing row instead of sending
 * again. Rows that fail are retried by the sweep in `lib/notifications/retry.ts`
 * with exponential backoff, up to `MAX_ATTEMPTS`.
 */
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  /** Machine-readable message type, e.g. `booking_confirmed`, `reminder_24h`. */
  kind: text("kind").notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  recipient: text("recipient").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  /**
   * HTML rendering of the same message. Stored (not just the text) because the
   * retry sweep re-sends from this row: without it, a retried email would
   * silently downgrade to plain text.
   */
  htmlBody: text("html_body"),
  /**
   * Legacy: the Twilio Content Variables ({"1": …, "2": …}) a templated
   * WhatsApp send carried. The WhatsApp transport was removed, so nothing
   * writes this column any more; the column stays so the rows that carry it
   * keep their history.
   */
  contentVariables: jsonb("content_variables").$type<Record<string, string>>(),
  status: notificationStatusEnum("status").notNull().default("queued"),
  /** Number of delivery attempts made so far. */
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /** Provider-side identifier (Resend message id, SMS message sid). */
  providerRef: text("provider_ref"),
  /** Stable key for "this exact message"; null when no dedup is wanted. */
  idempotencyKey: text("idempotency_key"),
  /** Earliest time a failed row may be retried. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (table) => [
  // Postgres treats nulls as distinct here, so un-keyed messages never collide.
  uniqueIndex("notifications_idempotency_key_unique").on(table.idempotencyKey),
  index("notifications_retry_idx").on(table.status, table.nextAttemptAt),
  index("notifications_kind_idx").on(table.kind, table.createdAt),
]);

export type Notification = typeof notifications.$inferSelect;
export type NotificationChannelName = Notification["channel"];
export type NotificationStatus = Notification["status"];

/**
 * Per-patient communication choices. Operational messages (bookings,
 * cancellations, reminders, payment and refund updates) respect the channel
 * toggles; anything promotional is additionally gated behind an explicit
 * opt-in, which this app does not send yet — the column exists so marketing
 * mail, if it ever comes, cannot start without consent.
 *
 * SMS needs its own recorded consent: a phone number alone is not permission.
 */
export const notificationPreferences = pgTable("notification_preferences", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  /** When the patient ticked the SMS consent box; null means never consented. */
  smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
  marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type NotificationPreferences = typeof notificationPreferences.$inferSelect;

/**
 * Operator-set notification configuration.
 *
 * Legacy: this table held the WhatsApp Content Template sid and sender, so an
 * operator could point the deployment at the right template without a
 * redeploy. The WhatsApp transport was removed and nothing reads or writes the
 * table now; it stays so the rows it holds keep their history. Dropping it is
 * a schema change with no runtime benefit, so it waits for a deliberate
 * migration.
 */
export const notificationSettings = pgTable("notification_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type NotificationSetting = typeof notificationSettings.$inferSelect;
