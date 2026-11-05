import type { NotificationChannel, NotificationMessage } from "../types";

/**
 * The Vonage SMS transport.
 *
 * Vonage is here because Twilio's *trial* account cannot carry a free-form SMS
 * body at all: it answers `572006` unless the body is the exact name of one of
 * Twilio's own predefined templates, so the clinic's message never reaches the
 * patient. Vonage's trial is far less restrictive — the body is delivered as
 * written, with a `[FREE SMS DEMO, TEST MESSAGE]` suffix appended by Vonage
 * itself — so a free account can still send a real appointment message.
 *
 * The wire format is the classic SMS API: one form-encoded POST to
 * `rest.nexmo.com/sms/json` carrying the API key, the API secret, the sender
 * and the text. No SDK, no JWT, no callback wiring.
 *
 *   VONAGE_API_KEY      — from the Vonage dashboard
 *   VONAGE_API_SECRET   — the paired secret
 *   VONAGE_FROM         — the sender: a number in E.164 (digits only, no
 *                         leading +) or an alphanumeric sender ID. Numbers are
 *                         the safe choice on a trial account; an alphanumeric
 *                         ID has to be registered for the destination country
 *                         (India requires DLT registration).
 *
 * Vonage answers HTTP 200 even when it refuses a message, so the refusal is in
 * the body: a per-message `status` other than `"0"`, or a top-level
 * `error-code` for an authentication failure. Both are thrown here, so the
 * ledger records the failure instead of claiming a delivery.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ENDPOINT = "https://rest.nexmo.com/sms/json";

/** The effective Vonage configuration, or null when it is not fully set up. */
export type VonageConfig = {
  apiKey: string;
  apiSecret: string;
  /** Exactly what goes in the `from` field: digits, or a sender ID. */
  from: string;
};

export function vonageConfig(
  env: Record<string, string | undefined> = process.env,
): VonageConfig | null {
  const apiKey = env.VONAGE_API_KEY?.trim();
  const apiSecret = env.VONAGE_API_SECRET?.trim();
  const from = env.VONAGE_FROM?.trim();

  if (!apiKey || !apiSecret || !from) return null;

  return { apiKey, apiSecret, from: normalizeSender(from) };
}

/**
 * Vonage wants a number as bare digits (`917380633176`) and a sender ID as
 * itself. A leading `+` is not accepted on the number form.
 */
export function normalizeSender(sender: string): string {
  const cleaned = sender.replace(/[\s()-]/g, "");
  if (/^\+?\d+$/.test(cleaned)) return cleaned.replace(/^\+/, "");
  return cleaned;
}

/** Vonage wants the recipient as digits too, without a leading `+`. */
function normalizeRecipient(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * Vonage bills and delivers non-ASCII text as UCS-2, which has to be declared;
 * ASCII text is sent as GSM. The clinic's messages contain `₹` and an em dash,
 * so the type is chosen from the text rather than guessed.
 */
function messageType(text: string): "text" | "unicode" {
  return /[^\x00-\x7F]/.test(text) ? "unicode" : "text";
}

type VonageMessage = {
  status?: string;
  "message-id"?: string;
  "error-text"?: string;
  to?: string;
};

type VonageResponse = {
  "error-code"?: string;
  "error-code-label"?: string;
  messages?: VonageMessage[];
};

/** What the deployment can see of the Vonage setup, without any secrets. */
export type VonageStatus = {
  credentials: boolean;
  sender: { present: boolean; tail: string | null };
  configured: boolean;
};

export function vonageStatus(
  env: Record<string, string | undefined> = process.env,
): VonageStatus {
  const apiKey = env.VONAGE_API_KEY?.trim();
  const apiSecret = env.VONAGE_API_SECRET?.trim();
  const sender = env.VONAGE_FROM?.trim() || null;

  return {
    credentials: Boolean(apiKey && apiSecret),
    sender: {
      present: sender !== null,
      tail: sender ? sender.replace(/[^\d]/g, "").slice(-4) || null : null,
    },
    configured: Boolean(apiKey && apiSecret && sender),
  };
}

export function createVonageChannel(deps?: { fetchImpl?: FetchLike }): NotificationChannel | null {
  const config = vonageConfig();
  if (!config) return null;

  const doFetch = deps?.fetchImpl ?? fetch;

  return {
    name: "vonage",
    async send(message: NotificationMessage) {
      const params = new URLSearchParams({
        api_key: config.apiKey,
        api_secret: config.apiSecret,
        from: config.from,
        to: normalizeRecipient(message.to),
        text: message.text,
        type: messageType(message.text),
      });

      const response = await doFetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        // Bounded so a hung provider can never hold up the flow that
        // triggered the send.
        signal: AbortSignal.timeout(8_000),
      });

      const body = await response.text().catch(() => "");

      if (!response.ok) {
        throw new Error(
          `Vonage rejected the SMS (${response.status}): ${body.slice(0, 200)}`,
        );
      }

      const payload = (JSON.parse(body || "{}") as VonageResponse) ?? {};

      // An authentication failure comes back as a top-level error rather than
      // a per-message result.
      if (payload["error-code"]) {
        throw new Error(
          `Vonage rejected the SMS (${payload["error-code"]}): ${
            payload["error-code-label"] ?? body.slice(0, 200)
          }`,
        );
      }

      const result = payload.messages?.[0];

      // Vonage answers 200 with a per-message status; only "0" means accepted.
      if (!result || result.status !== "0") {
        throw new Error(
          `Vonage rejected the SMS (${result?.status ?? "no response"}): ${
            result?.["error-text"] ?? body.slice(0, 200)
          }`,
        );
      }

      return { providerRef: result["message-id"] ?? null };
    },
  };
}

export type { FetchLike };
