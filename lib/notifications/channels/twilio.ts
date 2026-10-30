import type { NotificationChannel, NotificationMessage } from "../types";

/**
 * Twilio SMS transport (https://www.twilio.com/docs/sms). Plain `fetch` with
 * form-encoded bodies — no SDK, keeping the dependency tree small.
 *
 * Configuration (all three required; without any of them this transport is
 * not selected at all):
 *   TWILIO_ACCOUNT_SID  — from the Twilio console dashboard
 *   TWILIO_AUTH_TOKEN   — the paired auth token
 *   TWILIO_FROM         — an SMS-capable number or sender, E.164 (e.g. +14155550123)
 *
 * Recipients must also be E.164 (+<country code><number>); the preferences
 * action validates the patient's number into that shape.
 */
const apiRoot = (accountSid: string) =>
  `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createTwilioChannel(deps?: { fetchImpl?: FetchLike }): NotificationChannel | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;

  if (!accountSid || !authToken || !from) return null;

  const doFetch = deps?.fetchImpl ?? fetch;

  return {
    name: "twilio",
    async send(message: NotificationMessage) {
      const response = await doFetch(apiRoot(accountSid), {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: message.to,
          From: from,
          Body: message.text,
        }).toString(),
        // Bounded so a hung provider can never hold up the flow that triggered
        // the send.
        signal: AbortSignal.timeout(8_000),
      });

      // Twilio reports rejections (bad number, unverified sender, exhausted
      // quota) with 4xx and its own error codes in the body; either way the
      // ledger row must end up `failed` with the reason attached.
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Twilio rejected the SMS (${response.status}): ${body.slice(0, 200)}`);
      }

      // A 201 carries the message sid, which the ledger stores so a delivery
      // can be traced in the Twilio console from our own row.
      const payload = (await response.json().catch(() => null)) as { sid?: string } | null;
      return { providerRef: payload?.sid ?? null };
    },
  };
}
