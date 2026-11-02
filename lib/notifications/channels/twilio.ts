import type { NotificationChannel, NotificationMessage } from "../types";

/**
 * Twilio transports for SMS and WhatsApp. Both use the same Messages API, but
 * they are deliberately not shape-shifting copies of each other: SMS carries a
 * free-form `Body`, while WhatsApp carries an approved Content Template —
 * `ContentSid` plus `ContentVariables` and no `Body` at all.
 *
 * Configuration:
 *   TWILIO_ACCOUNT_SID           — from the Twilio console dashboard
 *   TWILIO_AUTH_TOKEN            — the paired auth token
 *   TWILIO_FROM                  — SMS-capable number or messaging service,
 *                                  E.164
 *   TWILIO_WHATSAPP_FROM         — WhatsApp sender, E.164
 *   TWILIO_WHATSAPP_CONTENT_SID  — the approved Content Template's `HX…` sid.
 *                                  The clinic's one appointment template must
 *                                  use `{{1}}` for the visit date and `{{2}}`
 *                                  for the visit time.
 *
 * WhatsApp is template-only on purpose: business-initiated free-form messages
 * are rejected by Twilio the moment the recipient's 24-hour window is closed
 * (and always on accounts without a registered sender), so a free-form send is
 * never attempted here. A message without template variables is refused before
 * the API is called, and a malformed or missing template sid counts as
 * "WhatsApp not configured" — the mobile message then rides SMS upstream (see
 * `events.ts`). Consent is to "mobile updates", never to a specific network.
 */
type TwilioKind = "sms" | "whatsapp";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LABEL: Record<TwilioKind, string> = { sms: "SMS", whatsapp: "WhatsApp" };

/** Content Template sids look like `HX` followed by 32 hex digits. */
const CONTENT_SID_PATTERN = /^HX[0-9a-f]{32}$/;

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
  const contentSid = process.env.TWILIO_WHATSAPP_CONTENT_SID;

  // A malformed template sid is treated as unconfigured rather than trusted:
  // Twilio would reject every send and the ledger would fill with noise.
  const templateSid =
    contentSid && CONTENT_SID_PATTERN.test(contentSid) ? contentSid : null;

  if (!accountSid || !authToken || !fromNumber) return null;
  if (kind === "whatsapp" && !templateSid) return null;

  const prefix = kind === "whatsapp" ? "whatsapp:" : "";
  const from = `${prefix}${normalizeE164(fromNumber)}`;
  const doFetch = deps?.fetchImpl ?? fetch;

  const request = {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    // Bounded so a hung provider can never hold up the flow that triggered
    // the send.
    signal: AbortSignal.timeout(8_000),
  } satisfies RequestInit;

  return {
    name: kind === "whatsapp" ? "twilio-whatsapp" : "twilio",
    async send(message: NotificationMessage) {
      const params = new URLSearchParams({
        To: `${prefix}${normalizeE164(message.to)}`,
        From: from,
      });

      // The two transports are not interchangeable, so the message parameters
      // are built on mutually exclusive branches: SMS speaks freely, WhatsApp
      // only repeats what the clinic's approved template can say.
      if (kind === "sms") {
        params.set("Body", message.text);
      } else if (!templateSid) {
        throw new Error(
          "Twilio WhatsApp requires an approved Content Template (ContentSid); none is configured.",
        );
      } else if (!message.contentVariables) {
        throw new Error(
          "Twilio WhatsApp is template-only: this message has no Content Template variables, so it should ride SMS instead of WhatsApp.",
        );
      } else {
        params.set("ContentSid", templateSid);
        params.set("ContentVariables", JSON.stringify(message.contentVariables));
      }

      const response = await doFetch(apiRoot(accountSid), {
        ...request,
        body: params.toString(),
      });

      // Twilio reports rejections (bad number, unverified sender, exhausted
      // quota, a recipient outside the 24-hour window) with 4xx and its own
      // error codes in the body; either way the ledger row must end up
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
