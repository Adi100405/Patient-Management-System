/**
 * Notifications are modelled as one small message plus a pluggable channel.
 * Email is the first channel; SMS and WhatsApp fit the same contract without
 * touching any caller, which is what the brief asks for ("extensible to
 * SMS/WhatsApp").
 */

export type NotificationMessage = {
  to: string;
  subject: string;
  /** Plain-text body. Plain text keeps templates honest and readable everywhere. */
  text: string;
  /** Free-form labels stored alongside the send for debugging and audit. */
  meta?: Record<string, string>;
};

export type NotificationChannel = {
  readonly name: string;
  send(message: NotificationMessage): Promise<void>;
};
