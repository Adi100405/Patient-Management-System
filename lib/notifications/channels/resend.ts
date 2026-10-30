import type { NotificationChannel, NotificationMessage } from "../types";

/**
 * Resend email transport (https://resend.com). Plain `fetch`, no SDK: the API
 * is one POST and this keeps the dependency tree small.
 *
 * Configuration:
 *   RESEND_API_KEY  — without it this transport is not selected at all
 *   RESEND_FROM     — optional; defaults to the Resend onboarding address, which
 *                     only delivers to the account's own email until a sending
 *                     domain is verified
 */
const RESEND_API_URL = "https://api.resend.com/emails";

export function createResendChannel(): NotificationChannel | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;

  const from = process.env.RESEND_FROM ?? "Medrella <onboarding@resend.dev>";

  return {
    name: "resend",
    async send(message: NotificationMessage) {
      const response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        // Bounded so a hung provider can never hold up the booking, refund or
        // webhook flow that triggered the send.
        signal: AbortSignal.timeout(8_000),
      });

      // A 4xx is our payload's problem (bad address, template bug) and a 5xx is
      // the provider's; either way the caller must be able to distinguish an
      // email that never left from one the provider bounced.
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Resend rejected the email (${response.status}): ${body.slice(0, 200)}`);
      }

      // Resend returns the queued message id; storing it makes a delivery
      // traceable in the provider dashboard from our own ledger row.
      const payload = (await response.json().catch(() => null)) as { id?: string } | null;
      return { providerRef: payload?.id ?? null };
    },
  };
}
