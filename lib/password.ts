import { createHash, randomBytes } from "node:crypto";

/**
 * The password-reset token is the one credential that proves who may set a
 * new password, so its contract is locked here in one small pure module:
 * unguessable, URL-safe, stored only as a digest, single-use, short-lived.
 *
 * Nothing in this file touches the database or the clock — callers pass both
 * in — so every rule is unit-testable without a Postgres or a server.
 */

/** The reset link dies after an hour: long enough to read an inbox, short enough that an old link stops being a live key. */
export const RESET_TOKEN_TTL_MINUTES = 60;

/** Seconds between two "send me a reset link" requests for the same account, so the form cannot hammer the mailer. */
export const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;

/**
 * A fresh token. 32 random bytes encoded unpadded base64url — 43 characters,
 * no `=`, `/`, `+` — so it can live inside a query string unescaped.
 */
export function createResetToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Only this digest is stored. The token itself travels once, in the emailed
 * link; a database leak therefore cannot mint usable reset links.
 */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** When a token minted at one moment expires. */
export function tokenExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
}

export type ResetTokenRecord = {
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
};

/**
 * Whether a stored token row may still grant a password change: inside its
 * lifetime and not already spent. Expiry is inclusive — the exact last
 * millisecond is already past, which reads naturally ("one hour" covers an
 * hour, not an hour and one tick) and keeps `tokenExpiresAt` honest under
 * `isTokenUsable(record, tokenExpiresAt(issuedAt))`.
 */
export function isTokenUsable(record: ResetTokenRecord, now: Date): boolean {
  if (record.usedAt !== null) return false;
  return now < record.expiresAt;
}

/**
 * Whether a session was issued before a password change. After a reset takes
 * the account back, a JWT minted earlier is evidence of an earlier trust
 * decision — the workflow requires it to be rejected everywhere the session
 * guard runs.
 */
export function isSessionStale(issuedAt: Date | null, passwordChangedAt: Date | null): boolean {
  // No change on record — nothing to compare against, nothing is invalidated.
  if (!passwordChangedAt) return false;

  // A token without an issue time cannot prove it postdates the change,
  // so it is treated as predating it: stale.
  if (!issuedAt) return true;

  return issuedAt < passwordChangedAt;
}
