import { logChannel } from "./channels/log";
import { createResendChannel } from "./channels/resend";
import { dispatchNotification, retryDueNotifications } from "./dispatch";
import { dbNotificationStore, type NotificationStore } from "./store";
import type {
  NotificationChannel,
  NotificationChannelName,
  NotificationMessage,
} from "./types";

export type {
  NotificationChannel,
  NotificationChannelName,
  NotificationMessage,
  NotificationSendResult,
  NotificationStatus,
} from "./types";

export type { NotificationRecord, NotificationStore } from "./store";

/**
 * The transport email goes out on. Resend when configured, the log channel
 * otherwise — so the pipeline is always live, and a deployment without keys
 * degrades to printing emails instead of failing bookings.
 */
export function getNotificationChannel(): NotificationChannel {
  return createResendChannel() ?? logChannel;
}

/**
 * Resolves the transport for a channel name. SMS has no transport yet; when
 * one lands it plugs in here without touching any caller.
 */
function channelFor(name: NotificationChannelName): NotificationChannel | null {
  return name === "email" ? getNotificationChannel() : null;
}

export type NotifyResult = {
  delivered: boolean;
  id: number | null;
  /** True when an earlier attempt already claimed this exact message. */
  duplicate: boolean;
};

export type NotifyOptions = {
  channel?: NotificationChannelName;
  /**
   * Stable key for "this exact message" (e.g. `booking_confirmed:42`). A
   * duplicate event finds the existing ledger row and sends nothing.
   */
  idempotencyKey?: string | null;
  now?: Date;
};

export type NotifierDependencies = {
  store: NotificationStore;
  channel: NotificationChannel;
};

/**
 * Sends one notification on the channel named in `options`. Never throws:
 * notification failure is logged and reported as `delivered: false`, because
 * no booking, payment or refund may fail because an email could not be sent.
 */
export async function notify(
  message: NotificationMessage,
  options?: NotifyOptions,
): Promise<NotifyResult> {
  const channelName = options?.channel ?? "email";
  const channel = channelFor(channelName);

  // An unconfigured channel is reported as a non-delivery, never faked: the
  // caller's contract ("was this message handed to a provider?") stays honest.
  if (!channel) {
    console.warn(`[notification] no transport configured for "${channelName}" — skipped`);
    return { delivered: false, id: null, duplicate: false };
  }

  return notifyWith({ store: dbNotificationStore, channel }, message, options);
}

/**
 * Testable form of `notify`, with the ledger and transport supplied by the
 * caller. `options.channel` only labels the ledger row here — the injected
 * transport is the truth.
 */
export async function notifyWith(
  deps: NotifierDependencies,
  message: NotificationMessage,
  options?: NotifyOptions,
): Promise<NotifyResult> {
  try {
    return await dispatchNotification(
      message,
      {
        kind: message.meta?.kind ?? "generic",
        channel: options?.channel ?? "email",
        idempotencyKey: options?.idempotencyKey ?? null,
      },
      { ...deps, now: options?.now },
    );
  } catch (error) {
    console.error(
      `[notification] ${deps.channel.name} failed for "${message.meta?.kind ?? "untyped"}" to ${message.to}:`,
      error instanceof Error ? error.message : error,
    );
    return { delivered: false, id: null, duplicate: false };
  }
}

/**
 * Re-attempts notifications whose backoff has elapsed. Called by the cron
 * sweep; a failure here is reported and swallowed so it cannot take down the
 * rest of the sweep.
 */
export async function retryFailedNotifications(options?: {
  limit?: number;
  now?: Date;
}): Promise<{ retried: number; sent: number }> {
  try {
    return await retryDueNotifications(
      {
        store: dbNotificationStore,
        resolveChannel: channelFor,
        now: options?.now,
      },
      options?.limit,
    );
  } catch (error) {
    console.error(
      "[notification] retry sweep failed:",
      error instanceof Error ? error.message : error,
    );
    return { retried: 0, sent: 0 };
  }
}
