import { nextAttemptAt } from "./retry-policy";
import type { NotificationChannel, NotificationChannelName, NotificationMessage } from "./types";
import type { NotificationRecord, NotificationStore } from "./store";

/**
 * The send-once-then-record half of the pipeline, with its store and transport
 * injected so it can be exercised without a database or a provider.
 */

export type DispatchDependencies = {
  store: NotificationStore;
  channel: NotificationChannel;
  now?: Date;
};

export type DispatchOutcome = {
  /** True when this message reached the provider on this attempt. */
  delivered: boolean;
  /** Ledger row id, or null when even the ledger write failed. */
  id: number | null;
  /** True when an earlier attempt already claimed this message. */
  duplicate: boolean;
};

export type DispatchMeta = {
  kind: string;
  channel: NotificationChannelName;
  /** Null or omitted: every call sends. Set it to make retries idempotent. */
  idempotencyKey?: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendRecord(
  record: NotificationRecord,
  channel: NotificationChannel,
  store: NotificationStore,
  now: Date,
): Promise<DispatchOutcome> {
  try {
    const result = await channel.send({
      to: record.recipient,
      subject: record.subject ?? "",
      text: record.body,
      html: record.htmlBody,
      meta: { kind: record.kind },
    });

    await store.markSent(record.id, result?.providerRef ?? null, now);
    return { delivered: true, id: record.id, duplicate: false };
  } catch (error) {
    // Failure is recorded, never rethrown: no booking, payment or refund may
    // fail because a provider is down.
    await store.markFailed(
      record.id,
      errorMessage(error),
      nextAttemptAt(now, record.attempts),
      now,
    );
    return { delivered: false, id: record.id, duplicate: false };
  }
}

/**
 * Sends one notification, claiming its idempotency key first.
 *
 * When the key was already claimed, nothing is sent: the previous attempt is
 * the truth. A previously failed row is deliberately not retried here either —
 * the cron sweep owns retries, so a duplicate event cannot turn into an
 * immediate re-send storm. The row still appears in the ledger either way.
 */
export async function dispatchNotification(
  message: NotificationMessage,
  meta: DispatchMeta,
  deps: DispatchDependencies,
): Promise<DispatchOutcome> {
  const now = deps.now ?? new Date();

  const { record, created } = await deps.store.claim(
    {
      kind: meta.kind,
      channel: meta.channel,
      recipient: message.to,
      // SMS has no subject line; the ledger keeps that honest with a null.
      subject: meta.channel === "email" ? message.subject : null,
      body: message.text,
      htmlBody: meta.channel === "email" ? (message.html ?? null) : null,
      idempotencyKey: meta.idempotencyKey ?? null,
    },
    now,
  );

  if (!created) {
    return { delivered: record.status === "sent", id: record.id, duplicate: true };
  }

  return sendRecord(record, deps.channel, deps.store, now);
}

export type RetryDependencies = {
  store: NotificationStore;
  /** Resolve a transport per channel; null means "no transport configured yet". */
  resolveChannel: (channel: NotificationChannelName) => NotificationChannel | null;
  now?: Date;
};

export type RetryOutcome = {
  /** Rows that came due and were claimed for another attempt. */
  retried: number;
  /** Rows that succeeded on this attempt. */
  sent: number;
};

/**
 * Retries every failed row whose backoff has elapsed.
 *
 * Each row is re-claimed with a conditional update before sending, so
 * overlapping sweeps cannot deliver the same message twice.
 */
export async function retryDueNotifications(
  deps: RetryDependencies,
  limit = 50,
): Promise<RetryOutcome> {
  const now = deps.now ?? new Date();
  const due = await deps.store.dueRetries(now, limit);

  let retried = 0;
  let sent = 0;

  for (const candidate of due) {
    const channel = deps.resolveChannel(candidate.channel);
    if (!channel) continue;

    const claimed = await deps.store.beginRetry(candidate.id, now);
    if (!claimed) continue;

    retried += 1;
    const outcome = await sendRecord(claimed, channel, deps.store, now);
    if (outcome.delivered) sent += 1;
  }

  return { retried, sent };
}
