import type { NotificationChannel, NotificationMessage } from "../types";

/**
 * The Twilio SMS transport.
 *
 * Configuration:
 *   TWILIO_ACCOUNT_SID  — from the Twilio console dashboard
 *   TWILIO_AUTH_TOKEN   — the paired auth token
 *   TWILIO_FROM         — SMS-capable number or messaging service, E.164
 *
 * Twilio also used to carry WhatsApp from this file. That transport is gone:
 * a WhatsApp send needs a Meta-approved Content Template, and the only one
 * this project could use was a fixed body that ignored the appointment date,
 * so a booking could have gone out with the wrong day on it. Mobile messages
 * ride SMS instead — see `events.ts`.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LABEL = "SMS";

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

/** What the deployment can see of the Twilio SMS setup, without any secrets. */
export type TwilioSmsStatus = {
  credentials: boolean;
  sender: { present: boolean; tail: string | null };
  configured: boolean;
  /**
   * Always true: a trial account's `572006` refusal is retried with a
   * predefined template, and a paid account never produces that error.
   */
  trialFallback: boolean;
};

export function twilioSmsStatus(
  env: Record<string, string | undefined> = process.env,
): TwilioSmsStatus {
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

export function createTwilioChannel(deps?: { fetchImpl?: FetchLike }): NotificationChannel | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM;

  if (!accountSid || !authToken || !fromNumber) {
    return null;
  }

  const from = normalizeE164(fromNumber);
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
    name: "twilio",
    async send(message: NotificationMessage) {
      const params = new URLSearchParams({
        To: normalizeE164(message.to),
        From: from,
        Body: message.text,
      });

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
        if (isTrialTemplateRejection(response.status, body)) {
          const template = smsTrialTemplate(message.meta?.kind);
          console.warn(
            `[notification] Twilio trial account: "${message.meta?.kind ?? "untyped"}" went out as the predefined "${template}" SMS — the clinic's own text needs an upgraded account.`,
          );

          const retried = await post(
            new URLSearchParams({
              To: normalizeE164(message.to),
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
            `Twilio rejected the ${LABEL} (${retried.status}): ${retryBody.slice(0, 200)}`,
          );
        }

        throw new Error(
          `Twilio rejected the ${LABEL} (${response.status}): ${body.slice(0, 200)}`,
        );
      }

      // A 201 carries the message sid, which the ledger stores so a delivery
      // can be traced in the Twilio console from our own row.
      const payload = (await response.json().catch(() => null)) as { sid?: string } | null;
      return { providerRef: payload?.sid ?? null };
    },
  };
}

export type { FetchLike };
