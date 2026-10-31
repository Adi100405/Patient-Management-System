"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { notificationPreferences, patients, users } from "@/db/schema";
import { requireRole } from "@/lib/session";

export type PreferencesState = { message?: string; error?: string } | null;

/**
 * Patient mobile numbers are stored E.164-ish: optional `+`, then 10–15
 * digits. Twilio requires E.164 on both sides, so the `+` is recommended in
 * the helper text and validated as part of this shape.
 */
const phoneSchema = z
  .string()
  .regex(/^\+?[0-9]{10,15}$/, "Enter a valid mobile number, e.g. +919876543210.");

const preferencesSchema = z.object({
  emailEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  smsConsent: z.boolean(),
  marketingOptIn: z.boolean(),
  phone: z.string().trim(),
});

function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) === "on";
}

export async function updateNotificationPreferences(
  _previous: PreferencesState,
  formData: FormData,
): Promise<PreferencesState> {
  const session = await requireRole("patient");

  const parsed = preferencesSchema.safeParse({
    emailEnabled: checkbox(formData, "emailEnabled"),
    smsEnabled: checkbox(formData, "smsEnabled"),
    smsConsent: checkbox(formData, "smsConsent"),
    marketingOptIn: checkbox(formData, "marketingOptIn"),
    phone: String(formData.get("phone") ?? "").trim(),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the values and try again." };
  }
  const { emailEnabled, smsEnabled, smsConsent, marketingOptIn, phone } = parsed.data;

  // Guard rails the UI cannot enforce alone: a patient must keep one reachable
  // channel, and mobile messaging needs both a number and a recorded consent.
  if (!emailEnabled && !smsEnabled) {
    return {
      error:
        "Keep at least one channel switched on, or you will not hear about appointment changes at all.",
    };
  }
  if (smsEnabled && !phone) {
    return { error: "Add your mobile number to receive mobile updates." };
  }
  if (smsEnabled && !smsConsent) {
    return { error: "Please tick the consent box so we may message you." };
  }
  if (smsEnabled) {
    const phoneCheck = phoneSchema.safeParse(phone);
    if (!phoneCheck.success) return { error: phoneCheck.error.issues[0]?.message };
  }

  const db = getDb();

  const [profile] = await db
    .select({ userId: users.id, currentPhone: patients.phone })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(patients.id, session.profileId))
    .limit(1);

  if (!profile) return { error: "Your profile could not be found. Try signing in again." };

  try {
    if (phone !== (profile.currentPhone ?? "")) {
      await db
        .update(patients)
        .set({ phone: phone || null })
        .where(eq(patients.id, session.profileId));
    }

    await db
      .insert(notificationPreferences)
      .values({
        userId: profile.userId,
        emailEnabled,
        smsEnabled,
        // Enabling re-records consent (the tick happened just now); disabling
        // clears it so a later re-enable requires a fresh, dated consent.
        smsConsentAt: smsEnabled ? new Date() : null,
        marketingOptIn,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: {
          emailEnabled,
          smsEnabled,
          smsConsentAt: smsEnabled ? new Date() : null,
          marketingOptIn,
          updatedAt: new Date(),
        },
      });
  } catch {
    return { error: "Could not save your preferences. Please try again." };
  }

  revalidatePath("/dashboard/patient");
  return { message: "Preferences saved." };
}
