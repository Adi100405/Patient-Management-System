import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { notificationPreferences } from "@/db/schema";

/**
 * What a patient has agreed to receive, and on which channel. Missing rows
 * read as the defaults (email on, SMS off, no consent) so a patient who never
 * opened settings still gets exactly what the clinic always sent.
 */

export type ResolvedPreferences = {
  emailEnabled: boolean;
  smsEnabled: boolean;
  /** When SMS consent was given; null means it never was. */
  smsConsentAt: Date | null;
  marketingOptIn: boolean;
};

export const defaultPreferences: ResolvedPreferences = {
  emailEnabled: true,
  smsEnabled: false,
  smsConsentAt: null,
  marketingOptIn: false,
};

export type ChannelPlan = { email: boolean; sms: boolean };

/**
 * Pure gate between preferences and the channels a message may use.
 *
 * SMS additionally requires a stored phone number and a recorded consent — a
 * number alone is not permission. Email only needs the toggle: the address is
 * already the account's login and the only way to reach the patient today.
 */
export function channelsFor(
  prefs: ResolvedPreferences,
  options: { phone: string | null },
): ChannelPlan {
  return {
    email: prefs.emailEnabled,
    sms: prefs.smsEnabled && prefs.smsConsentAt !== null && Boolean(options.phone),
  };
}

async function firstRow(userId: number) {
  const db = getDb();
  const [row] = await db
    .select({
      emailEnabled: notificationPreferences.emailEnabled,
      smsEnabled: notificationPreferences.smsEnabled,
      smsConsentAt: notificationPreferences.smsConsentAt,
      marketingOptIn: notificationPreferences.marketingOptIn,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);
  return row ?? null;
}

function toResolved(row: NonNullable<Awaited<ReturnType<typeof firstRow>>>): ResolvedPreferences {
  return {
    emailEnabled: row.emailEnabled,
    smsEnabled: row.smsEnabled,
    smsConsentAt: row.smsConsentAt,
    marketingOptIn: row.marketingOptIn,
  };
}

/**
 * Loads a patient's preferences, creating their default row on first touch so
 * a later settings save is a plain update.
 *
 * Notification failures must never break an appointment flow, so an unreadable
 * preferences table answers with the defaults instead of throwing.
 */
export async function preferencesForUser(userId: number): Promise<ResolvedPreferences> {
  try {
    const existing = await firstRow(userId);
    if (existing) return toResolved(existing);

    const db = getDb();
    const [created] = await db
      .insert(notificationPreferences)
      .values({ userId })
      .onConflictDoNothing()
      .returning({
        emailEnabled: notificationPreferences.emailEnabled,
        smsEnabled: notificationPreferences.smsEnabled,
        smsConsentAt: notificationPreferences.smsConsentAt,
        marketingOptIn: notificationPreferences.marketingOptIn,
      });
    if (created) return toResolved(created);

    // Another request created the row between our read and our insert.
    const raced = await firstRow(userId);
    return raced ? toResolved(raced) : defaultPreferences;
  } catch (error) {
    console.error(
      "[notification] preferences unavailable, using defaults:",
      error instanceof Error ? error.message : error,
    );
    return defaultPreferences;
  }
}
