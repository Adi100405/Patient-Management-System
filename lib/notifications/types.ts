/**
 * Notifications are modelled as one small message plus a pluggable channel.
 * Email is the first channel and SMS fits the same contract without touching
 * any caller — the brief asked for a pipeline that extends to mobile, and SMS
 * is where mobile lives today.
 */

/**
 * The transport a message travels on. Kept separate from the provider name.
 *
 * WhatsApp was a third channel and has been removed: every WhatsApp send
 * needs a Meta-approved template, and no account available to this project
 * could produce one that carried a real appointment date. Mobile messages now
 * ride SMS. Rows written before the removal still carry `whatsapp` in the
 * ledger, so the *stored* channel type keeps the value — see
 * `LedgerChannel` in `store.ts`.
 */
export type NotificationChannelName = "email" | "sms";

/** Lifecycle of a ledger row. */
export type NotificationStatus = "queued" | "sent" | "failed";

export type NotificationMessage = {
  to: string;
  subject: string;
  /** Plain-text body. Plain text keeps templates honest and readable everywhere. */
  text: string;
  /**
   * Optional HTML body. Providers send it alongside the text, so clients that
   * render HTML show the branded message and a fallback still receives the
   * plain text. Absent for SMS and for any text-only send.
   */
  html?: string | null;
  /** Free-form labels stored alongside the send for debugging and audit. */
  meta?: Record<string, string>;
};

/**
 * What a channel reports back after a successful send. `providerRef` is the
 * provider's own identifier (a Resend message id, an SMS sid) and is stored on
 * the ledger row so a delivery can be looked up in the provider's dashboard.
 */
export type NotificationSendResult = {
  providerRef?: string | null;
  /**
   * Set when a fallback carried the message instead of the text the clinic
   * wrote: on a Twilio trial account an SMS goes out as one of Twilio's
   * predefined templates (`572006`). Null or absent otherwise.
   */
  trialTemplate?: string | null;
};

export type NotificationChannel = {
  readonly name: string;
  send(message: NotificationMessage): Promise<NotificationSendResult | void>;
};
