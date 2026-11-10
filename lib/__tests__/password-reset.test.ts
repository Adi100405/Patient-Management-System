import { describe, expect, it } from "vitest";
import {
  RESET_REQUEST_COOLDOWN_MS,
  RESET_TOKEN_TTL_MINUTES,
  createResetToken,
  hashResetToken,
  isSessionStale,
  isTokenUsable,
  tokenExpiresAt,
} from "@/lib/password";

// Fixed instant to keep the lifetimes in the test honest.
const issuedAt = new Date("2026-11-06T10:00:00.000Z");

/**
 * The reset token is the one secret that proves who may set a new password,
 * so its contract is what these tests lock: unguessable, URL-safe, stored
 * only as a digest, single-use, short-lived.
 */
describe("password reset tokens", () => {
  it("produces a URL-safe base64 token of 32 bytes", () => {
    const token = createResetToken();

    // 32 bytes -> 43 characters of unpadded base64url.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The token travels inside a query string: no characters can need escaping.
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("never repeats a token", () => {
    expect(createResetToken()).not.toBe(createResetToken());
  });

  it("hashes a token to the sha256 digest, deterministically", () => {
    const token = createResetToken();

    const once = hashResetToken(token);
    const twice = hashResetToken(token);

    expect(once).toMatch(/^[0-9a-f]{64}$/);
    expect(once).toBe(twice);
    // The stored digest is not the token itself.
    expect(once).not.toContain(token);
  });

  it("expires the token after the configured lifetime", () => {
    expect(RESET_TOKEN_TTL_MINUTES).toBe(60);
    expect(tokenExpiresAt(issuedAt).getTime()).toBe(issuedAt.getTime() + 60 * 60 * 1000);
  });

  it("spaces repeated requests by the cooldown", () => {
    expect(RESET_REQUEST_COOLDOWN_MS).toBe(60 * 1000);
  });

  describe("isTokenUsable", () => {
    it("accepts an unused token inside its lifetime", () => {
      expect(
        isTokenUsable({ expiresAt: tokenExpiresAt(issuedAt), usedAt: null }, issuedAt),
      ).toBe(true);
    });

    it("refuses an expired token", () => {
      const record = { expiresAt: tokenExpiresAt(issuedAt), usedAt: null };
      // One tick past the lifetime — inclusive boundary.
      expect(isTokenUsable(record, new Date("2026-11-06T11:00:00.000Z"))).toBe(false);
    });

    it("refuses a token that has already been used, even inside its lifetime", () => {
      const record = { expiresAt: tokenExpiresAt(issuedAt), usedAt: issuedAt };

      expect(isTokenUsable(record, new Date("2026-11-06T10:05:00.000Z"))).toBe(false);
    });
  });

  describe("isSessionStale", () => {
    const changedAt = new Date("2026-11-06T10:00:00.000Z");

    it("rejects a session issued before the password change", () => {
      expect(isSessionStale(new Date("2026-11-06T09:59:59.999Z"), changedAt)).toBe(true);
    });

    it("keeps a session issued at or after the password change", () => {
      expect(isSessionStale(new Date("2026-11-06T10:00:00.000Z"), changedAt)).toBe(false);
      expect(isSessionStale(new Date("2026-11-06T10:00:01.000Z"), changedAt)).toBe(false);
    });

    it("never invalidates anything while no password change has happened", () => {
      expect(isSessionStale(new Date("2019-01-01T00:00:00.000Z"), null)).toBe(false);
    });

    it("treats a token with no issue time as unprovable, therefore stale", () => {
      expect(isSessionStale(null, changedAt)).toBe(true);
    });
  });
});
