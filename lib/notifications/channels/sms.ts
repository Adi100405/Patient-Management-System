import type { NotificationChannel } from "../types";
import { createTwilioChannel, twilioSmsStatus, type FetchLike } from "./twilio";
import { createVonageChannel, vonageStatus } from "./vonage";

/**
 * The SMS transport, and the provider behind it.
 *
 * SMS is one channel with two possible providers, and the ledger does not care
 * which one carried a message — its channel column is `email | sms | whatsapp`,
 * so a provider swap needs no schema change and no migration.
 *
 *   Vonage  — preferred when configured. Its trial delivers the clinic's own
 *             text (with a demo suffix Vonage appends itself), so a free
 *             account can carry a real appointment message.
 *   Twilio  — the fallback. On a *trial* Twilio account a free-form body is
 *             refused outright (`572006`), so the Twilio transport degrades to
 *             one of Twilio's predefined templates; on a paid account it sends
 *             the real text.
 *
 * Vonage wins when both are configured, because it is the one that carries the
 * real message on a free account.
 */

export type SmsProviderName = "vonage" | "twilio";

/** Which provider this deployment would use, or null when SMS is unconfigured. */
export function smsProvider(
  env: Record<string, string | undefined> = process.env,
): SmsProviderName | null {
  if (vonageConfigured(env)) return "vonage";
  if (twilioConfigured(env)) return "twilio";
  return null;
}

function vonageConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.VONAGE_API_KEY?.trim() &&
      env.VONAGE_API_SECRET?.trim() &&
      env.VONAGE_FROM?.trim(),
  );
}

function twilioConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID?.trim() &&
      env.TWILIO_AUTH_TOKEN?.trim() &&
      env.TWILIO_FROM?.trim(),
  );
}

/** The SMS transport for whichever provider is configured. */
export function createSmsChannel(deps?: { fetchImpl?: FetchLike }): NotificationChannel | null {
  return createVonageChannel(deps) ?? createTwilioChannel(deps);
}

/** What the deployment can see of the SMS setup, without any secrets. */
export type SmsStatus = {
  /** The provider that would carry the next SMS, or null when there is none. */
  provider: SmsProviderName | null;
  credentials: boolean;
  sender: { present: boolean; tail: string | null };
  configured: boolean;
  /**
   * True only for the Twilio transport: a trial Twilio account may substitute
   * one of Twilio's predefined templates for the clinic's text. Vonage never
   * does — it sends the message as written.
   */
  trialFallback: boolean;
};

export function smsStatus(
  env: Record<string, string | undefined> = process.env,
): SmsStatus {
  const provider = smsProvider(env);

  if (provider === "vonage") {
    const status = vonageStatus(env);
    return {
      provider,
      credentials: status.credentials,
      sender: status.sender,
      configured: status.configured,
      trialFallback: false,
    };
  }

  const status = twilioSmsStatus(env);
  return {
    provider,
    credentials: status.credentials,
    sender: status.sender,
    configured: status.configured,
    trialFallback: status.trialFallback,
  };
}

export type { FetchLike };
