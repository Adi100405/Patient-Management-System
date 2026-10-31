/**
 * Notifications are modelled as one small message plus a pluggable channel.
 * Email is the first channel; SMS and WhatsApp fit the same contract without
 * touching any caller, which is what the brief asks for ("extensible to
 * SMS/WhatsApp").
 */

/** The transport a message travels on. Kept separate from the provider name. */
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
};

export type NotificationChannel = {
  readonly name: string;
  send(message: NotificationMessage): Promise<NotificationSendResult | void>;
};
