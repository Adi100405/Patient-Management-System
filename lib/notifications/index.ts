import { logChannel } from "./channels/log";
import { createResendChannel } from "./channels/resend";
import type { NotificationChannel, NotificationMessage } from "./types";

export type { NotificationChannel, NotificationMessage } from "./types";

/**
 * The channel notifications go out on. Resend when configured, the log channel
 * otherwise — so the pipeline is always live, and a deployment without keys
 * degrades to printing emails instead of failing bookings.
 */
export function getNotificationChannel(): NotificationChannel {
  return createResendChannel() ?? logChannel;
}

/**
 * Sends one notification and reports whether it was delivered. Never throws:
 * notification failure is logged and swallowed, because no booking, payment or
 * refund may fail because an email could not be sent.
 */
export async function notify(message: NotificationMessage): Promise<boolean> {
  const channel = getNotificationChannel();
  try {
    await channel.send(message);
    return true;
  } catch (error) {
    console.error(
      `[notification] ${channel.name} failed for "${message.meta?.kind ?? "untyped"}" to ${message.to}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
