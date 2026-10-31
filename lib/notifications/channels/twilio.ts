import type { NotificationChannel, NotificationMessage } from "../types";

/**
 * Twilio transports for SMS and WhatsApp. Both use the same Messages API — the
 * only differences are the address prefix and the sender number — so they share
 * one implementation.
 *
 * Configuration:
 *   TWILIO_ACCOUNT_SID    — from the Twilio console dashboard
 *   TWILIO_AUTH_TOKEN     — the paired auth token
 *   TWILIO_FROM           — SMS-capable number or messaging service, E.164
 *   TWILIO_WHATSAPP_FROM  — WhatsApp sender, E.164. For development use
 *                           Twilio's free sandbox number (+14155238886) after
 *                           joining it from the recipient's phone.
 *
 * WhatsApp is chosen as the mobile channel only when its sender is configured
 * explicitly: the sandbox is never assumed, because a clinic that already has
 * SMS working must not silently have it replaced by WhatsApp.
 */
type TwilioKind = "sms" | "whatsapp";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LABEL: Record<TwilioKind, string> = { sms: "SMS", whatsapp: "WhatsApp" };

const apiRoot = (accountSid: string) =>
  `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

/** Keep digits and a leading plus: " +91 98765 43210 " is the same number. */
function normalizeE164(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, "");
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

function createTwilioTransport(
  kind: TwilioKind,
  deps?: { fetchImpl?: FetchLike },
): NotificationChannel | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber =
    kind === "whatsapp" ? process.env.TWILIO_WHATSAPP_FROM : process.env.TWILIO_FROM;

  if (!accountSid || !authToken || !fromNumber) return null;

  const prefix = kind === "whatsapp" ? "whatsapp:" : "";
  const from = `${prefix}${normalizeE164(fromNumber)}`;
  const doFetch = deps?.fetchImpl ?? fetch;

  return {
    name: kind === "whatsapp" ? "twilio-whatsapp" : "twilio",
    async send(message: NotificationMessage) {
      const response = await doFetch(apiRoot(accountSid), {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: `${prefix}${normalizeE164(message.to)}`,
          From: from,
          Body: message.text,
        }).toString(),
        // Bounded so a hung provider can never hold up the flow that triggered
        // the send.
        signal: AbortSignal.timeout(8_000),
      });

      // Twilio reports rejections (bad number, unverified sender, exhausted
      // quota, a WhatsApp message outside the 24-hour window) with 4xx and its
      // own error codes in the body; either way the ledger row must end up
      // `failed` with the reason attached.
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Twilio rejected the ${LABEL[kind]} (${response.status}): ${body.slice(0, 200)}`,
        );
      }

      // A 201 carries the message sid, which the ledger stores so a delivery
      // can be traced in the Twilio console from our own row.
      const payload = (await response.json().catch(() => null)) as { sid?: string } | null;
      return { providerRef: payload?.sid ?? null };
    },
  };
}

export function createTwilioChannel(deps?: { fetchImpl?: FetchLike }): NotificationChannel | null {
  return createTwilioTransport("sms", deps);
}

export function createTwilioWhatsAppChannel(deps?: {
  fetchImpl?: FetchLike;
}): NotificationChannel | null {
  return createTwilioTransport("whatsapp", deps);
}

export type { FetchLike };