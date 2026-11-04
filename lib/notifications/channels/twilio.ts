import type { NotificationChannel, NotificationMessage } from "../types";
import { cachedWhatsappSettings } from "../settings";

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
const CONTENT_SID_PATTERN = /^HX[0-9a-f]{32}$/i;

/**
 * Accepts a Content Template sid the way it actually arrives from the Twilio
 * console: trimmed, optionally wrapped in quotes, and — because the console's
 * API snippet is the obvious place to copy from — optionally prefixed with
 * `ContentSid=`. Twilio's own pattern (`^HX[0-9a-fA-F]{32}$`) treats hex case
 * as insignificant, so this does too. Anything else stays `null`: a malformed
 * sid counts as "WhatsApp not configured" rather than being sent to Twilio.
 */
export function normalizeContentSid(raw: string | undefined): string | null {
  if (!raw) return null;

  let value = raw.trim();
  const unquote = (input: string) => {
    const first = input[0];
    const last = input[input.length - 1];
    return input.length >= 2 &&
      ((first === '"' && last === '"') || (first === "'" && last === "'"))
      ? input.slice(1, -1).trim()
      : input;
  };

  value = unquote(value);
  value = value.replace(/^contentsid\s*=\s*/i, "");
  value = unquote(value.trim());

  return CONTENT_SID_PATTERN.test(value) ? value : null;
}

/** What the deployment can see of the WhatsApp setup, without any secrets. */
export type WhatsappStatus = {
  credentials: boolean;
  sender: boolean;
  contentSid: {
    present: boolean;
    valid: boolean;
    /** Last four characters only, enough to compare two environments. */
    tail: string | null;
    /** Where the sid came from: the environment, or the runtime settings. */
    source: "env" | "runtime" | null;
  };
  configured: boolean;
};

/**
 * The effective WhatsApp configuration.
 *
 * The environment comes first, because it is what a deployment is built with;
 * a runtime setting wins when the operator has deliberately pointed the app at
 * another template — for example when the environment still carries a template
 * that Twilio no longer accepts.
 */
export type WhatsappConfig = {
  accountSid: string | null;
  authToken: string | null;
  sender: string | null;
  contentSid: string | null;
  contentSidSource: "env" | "runtime" | null;
};

export function whatsappConfig(
  env: Record<string, string | undefined> = process.env,
  runtime: { contentSid: string | null; sender: string | null } = {
    contentSid: null,
    sender: null,
  },
): WhatsappConfig {
  const envSid = normalizeContentSid(env.TWILIO_WHATSAPP_CONTENT_SID);
  const runtimeSid = normalizeContentSid(runtime.contentSid ?? undefined);

  const contentSid = runtimeSid ?? envSid;
  const contentSidSource = runtimeSid ? "runtime" : envSid ? "env" : null;

  return {
    accountSid: env.TWILIO_ACCOUNT_SID ?? null,
    authToken: env.TWILIO_AUTH_TOKEN ?? null,
    sender: env.TWILIO_WHATSAPP_FROM ?? runtime.sender ?? null,
    contentSid,
    contentSidSource,
  };
}

export function whatsappStatus(
  env: Record<string, string | undefined> = process.env,
  runtime: { contentSid: string | null; sender: string | null } = {
    contentSid: null,
    sender: null,
  },
): WhatsappStatus {
  const config = whatsappConfig(env, runtime);
  const rawSid =
    env.TWILIO_WHATSAPP_CONTENT_SID ?? runtime.contentSid ?? undefined;

  return {
    credentials: Boolean(config.accountSid && config.authToken),
    sender: Boolean(config.sender),
    contentSid: {
      present: Boolean(rawSid && rawSid.trim()),
      valid: config.contentSid !== null,
      tail: config.contentSid ? config.contentSid.slice(-4) : null,
      source: config.contentSidSource,
    },
    configured: Boolean(
      config.accountSid && config.authToken && config.sender && config.contentSid,
    ),
  };
}

/**
 * Twilio trial accounts cannot send a free-form SMS at all. The Messages API
 * answers `572006 Invalid template name` unless `Body` is *exactly* the name of
 * one of Twilio's own predefined SMS templates — the message Twilio then
 * delivers is Twilio's fixed text, not ours. Upgrading the account lifts the
 * restriction and the free-form body works as written.
 *
 * So the app keeps writing real messages, and treats `572006` as "this account
 * is on trial": the send is retried once with the predefined template closest
 * to the event. A paid account never returns that error, which means the
 * fallback can never fire there — there is nothing to remember to switch off.
 * What the patient receives is Twilio's demo sentence with Twilio's own
 * "Test message from Twilio." suffix, so the degradation is visible on the
 * handset too; the ledger still records the text the clinic meant to send.
 */
const TRIAL_TEMPLATE_BY_KIND: Record<string, string> = {
  booking_confirmed: "sms_appointment_reminders",
  appointment_rescheduled: "sms_appointment_reminders",
  appointment_cancelled: "sms_appointment_reminders",
  reminder_24h: "sms_appointment_reminders",
  reminder_1h: "sms_appointment_reminders",
  follow_up_prompt: "sms_appointment_reminders",
  payment_confirmed: "sms_order_confirmation",
  refund_initiated: "sms_customer_support",
  refund_completed: "sms_customer_support",
  refund_failed: "sms_customer_support",
  visit_thanks: "sms_feedback_surveys",
};

/** Twilio's "we received your message" template — the safest thing to say
 * when an event has no closer match. */
const DEFAULT_TRIAL_TEMPLATE = "sms_customer_support";

/** Every predefined template this app can send, for status and docs. */
export const SMS_TRIAL_TEMPLATE_NAMES = [
  "sms_appointment_reminders",
  "sms_order_confirmation",
  "sms_customer_support",
  "sms_feedback_surveys",
] as const;

/** The predefined template that stands in for an event's real message. */
export function smsTrialTemplate(kind: string | undefined): string {
  if (kind && Object.hasOwn(TRIAL_TEMPLATE_BY_KIND, kind)) {
    return TRIAL_TEMPLATE_BY_KIND[kind];
  }
  return DEFAULT_TRIAL_TEMPLATE;
}

/** Twilio's `572006`, in the shape it arrives: a 4xx with a JSON body. */
function isTrialTemplateRejection(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  try {
    return (JSON.parse(body) as { code?: number }).code === 572006;
  } catch {
    return body.includes("572006");
  }
}

/** What the deployment can see of the SMS setup, without any secrets. */
export type SmsStatus = {
  credentials: boolean;
  sender: { present: boolean; tail: string | null };
  configured: boolean;
  /**
   * Always true: a trial account's `572006` refusal is retried with a
   * predefined template, and a paid account never produces that error.
   */
  trialFallback: boolean;
};

export function smsStatus(
  env: Record<string, string | undefined> = process.env,
): SmsStatus {
  const sender = env.TWILIO_FROM?.trim() || null;
  const credentials = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);

  return {
    credentials,
    sender: {
      present: sender !== null,
      tail: sender ? sender.replace(/[^\d]/g, "").slice(-4) || null : null,
    },
    configured: Boolean(credentials && sender),
    trialFallback: true,
  };
}

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
  const runtime = cachedWhatsappSettings();
  const whatsapp = whatsappConfig(process.env, runtime);

  const accountSid = kind === "whatsapp" ? whatsapp.accountSid : process.env.TWILIO_ACCOUNT_SID;
  const authToken = kind === "whatsapp" ? whatsapp.authToken : process.env.TWILIO_AUTH_TOKEN;
  const fromNumber =
    kind === "whatsapp" ? whatsapp.sender : process.env.TWILIO_FROM;
  const contentSid = kind === "whatsapp" ? whatsapp.contentSid : null;

  // A malformed template sid is treated as unconfigured rather than trusted:
  // Twilio would reject every send and the ledger would fill with noise.
  if (kind === "whatsapp") {
    const status = whatsappStatus(process.env, runtime);
    if (!status.configured) {
      const missing = [
        !status.credentials && "Twilio credentials",
        !status.sender && "TWILIO_WHATSAPP_FROM",
        !status.contentSid.present && "TWILIO_WHATSAPP_CONTENT_SID",
        status.contentSid.present && !status.contentSid.valid && "a valid HX… Content sid",
      ].filter(Boolean);
      console.warn(`[notification] WhatsApp disabled — check ${missing.join(", ")}.`);
      return null;
    }
  }

  if (!accountSid || !authToken || !fromNumber) {
    return null;
  }

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
      } else if (!contentSid) {
        throw new Error(
          "Twilio WhatsApp requires an approved Content Template (ContentSid); none is configured.",
        );
      } else if (!message.contentVariables) {
        throw new Error(
          "Twilio WhatsApp is template-only: this message has no Content Template variables, so it should ride SMS instead of WhatsApp.",
        );
      } else {
        params.set("ContentSid", contentSid);
        params.set("ContentVariables", JSON.stringify(message.contentVariables));
      }

      const post = (payload: URLSearchParams) =>
        doFetch(apiRoot(accountSid), { ...request, body: payload.toString() });

      const response = await post(params);

      // Twilio reports rejections (bad number, unverified sender, exhausted
      // quota, a recipient outside the 24-hour window) with 4xx and its own
      // error codes in the body; either way the ledger row must end up
      // `failed` with the reason attached.
      if (!response.ok) {
        const body = await response.text().catch(() => "");

        // A trial account refuses every free-form body (`572006`) and accepts
        // only a predefined template name. Retrying once keeps the demo
        // deliverable and says plainly, in the log, that the handset is about
        // to show Twilio's sentence rather than the clinic's.
        if (kind === "sms" && isTrialTemplateRejection(response.status, body)) {
          const template = smsTrialTemplate(message.meta?.kind);
          console.warn(
            `[notification] Twilio trial account: "${message.meta?.kind ?? "untyped"}" went out as the predefined "${template}" SMS — the clinic's own text needs an upgraded account.`,
          );

          const retried = await post(
            new URLSearchParams({
              To: `${prefix}${normalizeE164(message.to)}`,
              From: from,
              Body: template,
            }),
          );

          if (retried.ok) {
            const accepted = (await retried.json().catch(() => null)) as { sid?: string } | null;
            return { providerRef: accepted?.sid ?? null, trialTemplate: template };
          }

          const retryBody = await retried.text().catch(() => "");
          throw new Error(
            `Twilio rejected the ${LABEL[kind]} (${retried.status}): ${retryBody.slice(0, 200)}`,
          );
        }

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
