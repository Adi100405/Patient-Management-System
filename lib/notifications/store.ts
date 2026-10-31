import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { notifications } from "@/db/schema";
import { MAX_ATTEMPTS } from "./retry-policy";
import type { NotificationChannelName, NotificationStatus } from "./types";

/**
 * The persistence half of the notification pipeline, behind a small interface
 * so the dispatch logic can be unit-tested against an in-memory store instead
 * of a live database.
 */

export type NotificationRecord = {
  id: number;
  kind: string;
  channel: NotificationChannelName;
  recipient: string;
  subject: string | null;
  body: string;
  /** HTML rendering of the same message; null for SMS and text-only sends. */
  htmlBody: string | null;
  status: NotificationStatus;
  attempts: number;
};

export type NotificationDraft = {
  kind: string;
  channel: NotificationChannelName;
  recipient: string;
  subject: string | null;
  body: string;
  htmlBody: string | null;
  /** Null when the message should always be sent, never deduplicated. */
  idempotencyKey: string | null;
};

export type ClaimResult = {
  record: NotificationRecord;
  /** False when an existing row already claimed this idempotency key. */
  created: boolean;
};

export type NotificationStore = {
  claim(draft: NotificationDraft, now: Date): Promise<ClaimResult>;
  beginRetry(id: number, now: Date): Promise<NotificationRecord | null>;
  markSent(id: number, providerRef: string | null, at: Date): Promise<void>;
  markFailed(id: number, error: string, retryAt: Date, at: Date): Promise<void>;
  dueRetries(now: Date, limit: number): Promise<NotificationRecord[]>;
};

function toRecord(row: typeof notifications.$inferSelect): NotificationRecord {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    htmlBody: row.htmlBody,
    status: row.status,
    attempts: row.attempts,
  };
}

export const dbNotificationStore: NotificationStore = {
  async claim(draft, now) {
    const db = getDb();

    // A null idempotency key never conflicts, so un-keyed messages always
    // insert; a keyed message that already exists comes back as `created:false`
    // and the caller must not send it a second time.
    const [created] = await db
      .insert(notifications)
      .values({
        kind: draft.kind,
        channel: draft.channel,
        recipient: draft.recipient,
        subject: draft.subject,
        body: draft.body,
        htmlBody: draft.htmlBody,
        status: "queued",
        attempts: 1,
        idempotencyKey: draft.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (created) return { record: toRecord(created), created: true };

    if (!draft.idempotencyKey) {
      throw new Error("notification insert returned no row without an idempotency key");
    }

    const [existing] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.idempotencyKey, draft.idempotencyKey))
      .limit(1);

    if (!existing) {
      throw new Error(`notification idempotency key ${draft.idempotencyKey} conflicted but no row was found`);
    }

    return { record: toRecord(existing), created: false };
  },

  async beginRetry(id, now) {
    const db = getDb();
    const [row] = await db
      .update(notifications)
      .set({
        status: "queued",
        attempts: sql`${notifications.attempts} + 1`,
        nextAttemptAt: null,
        updatedAt: now,
      })
      // Conditional on the row still being failed and under the attempt cap, so
      // two sweeps racing for the same row cannot both send it.
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.status, "failed"),
          lt(notifications.attempts, MAX_ATTEMPTS),
        ),
      )
      .returning();

    return row ? toRecord(row) : null;
  },

  async markSent(id, providerRef, at) {
    const db = getDb();
    await db
      .update(notifications)
      .set({
        status: "sent",
        providerRef,
        lastError: null,
        sentAt: at,
        updatedAt: at,
        nextAttemptAt: null,
      })
      .where(eq(notifications.id, id));
  },

  async markFailed(id, error, retryAt, at) {
    const db = getDb();
    await db
      .update(notifications)
      .set({
        status: "failed",
        lastError: error.slice(0, 500),
        nextAttemptAt: retryAt,
        updatedAt: at,
      })
      .where(eq(notifications.id, id));
  },

  async dueRetries(now, limit) {
    const db = getDb();
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.status, "failed"),
          lt(notifications.attempts, MAX_ATTEMPTS),
          lte(notifications.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(notifications.nextAttemptAt))
      .limit(limit);

    return rows.map(toRecord);
  },
};
