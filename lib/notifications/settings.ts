import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { notificationSettings } from "@/db/schema";

/**
 * Runtime configuration for the mobile transport.
 *
 * The environment is the source of truth for *credentials* — the Twilio auth
 * token never leaves it. A Content Template sid, though, is only an
 * identifier, and it is the one piece of the WhatsApp setup that changes
 * whenever a template is approved, replaced or re-created. Holding it in the
 * database means the person operating the clinic can point the app at the
 * right template without a redeploy.
 *
 * Reads are cached for a short window: a notification event asks for the
 * configuration on every send, and the answer changes rarely.
 */

export const WHATSAPP_CONTENT_SID_KEY = "whatsapp_content_sid";
export const WHATSAPP_SENDER_KEY = "whatsapp_from";

export type WhatsappSettings = {
  /** The `HX…` Content Template sid the deployment should send with. */
  contentSid: string | null;
  /** The WhatsApp sender, when the environment does not carry one. */
  sender: string | null;
};

const EMPTY: WhatsappSettings = { contentSid: null, sender: null };

/** How long a cached snapshot is trusted before it is read again. */
const CACHE_TTL_MS = 30_000;

let cached: WhatsappSettings | null = null;
let cachedAt = 0;

/** The last known configuration, without touching the database. */
export function cachedWhatsappSettings(): WhatsappSettings {
  return cached ?? EMPTY;
}

/**
 * Reads the stored configuration and refreshes the cache.
 *
 * A missing table or an unreachable database is logged and ignored: the
 * environment still carries a working setup, and a notification must never
 * fail because a settings row could not be read.
 */
export async function loadWhatsappSettings(options?: { force?: boolean }): Promise<WhatsappSettings> {
  if (!options?.force && cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.key, WHATSAPP_CONTENT_SID_KEY))
      .limit(1);
    const contentRow = rows[0];

    const senderRows = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.key, WHATSAPP_SENDER_KEY))
      .limit(1);

    cached = {
      contentSid: contentRow?.value ?? null,
      sender: senderRows[0]?.value ?? null,
    };
  } catch (error) {
    console.warn(
      "[notification] runtime settings unavailable:",
      error instanceof Error ? error.message : error,
    );
    cached = cached ?? EMPTY;
  }

  cachedAt = Date.now();
  return cached;
}

/**
 * Stores one setting. An empty value removes the row, so the environment is
 * back in charge.
 */
export async function saveWhatsappSetting(key: string, value: string | null): Promise<void> {
  const db = getDb();

  if (value === null) {
    await db.delete(notificationSettings).where(eq(notificationSettings.key, key));
  } else {
    await db
      .insert(notificationSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: notificationSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  await loadWhatsappSettings({ force: true });
}
