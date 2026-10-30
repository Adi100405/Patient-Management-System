/**
 * Retry policy for failed notifications.
 *
 * Failures are retried by the cron sweep, not inline: a provider outage should
 * not turn one booking into a burst of immediate retries. Backoff is
 * exponential and capped so a row keeps being retried for most of a day, and
 * `MAX_ATTEMPTS` stops a permanently broken address from being retried forever.
 */
export const MAX_ATTEMPTS = 5;

const BACKOFF_MS = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  15 * 60_000, // 15 minutes
  60 * 60_000, // 1 hour
  6 * 60 * 60_000, // 6 hours
] as const;

/**
 * Delay before the next attempt. `attempts` is the number of attempts already
 * made, so the first failure waits a minute.
 */
export function backoffFor(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[index];
}

export function nextAttemptAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + backoffFor(attempts));
}
