import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, verifySession } from "@/lib/jwt";

describe("session token", () => {
  it("carries the moment it was issued, so a later password change can be compared against it", async () => {
    const token = await signSession({
      userId: 7,
      role: "patient",
      name: "Riya Sharma",
      profileId: 3,
    });

    const session = await verifySession(token);

    expect(session).not.toBeNull();
    expect(session?.issuedAt).toBeTypeOf("number");
    // jose stamps `iat` in whole seconds; it must be a plausible instant.
    expect(session?.issuedAt ?? 0).toBeLessThanOrEqual(Date.now() / 1000);
  });

  it("still refuses a malformed token outright", async () => {
    const session = await verifySession("not-a-jwt");

    expect(session).toBeNull();
  });

  it("round-trips the identity the guard depends on", async () => {
    const payload = {
      userId: 11,
      role: "doctor" as const,
      name: "Dr. Aarav Mehta",
      profileId: 5,
    };

    const token = await signSession(payload);
    const session = await verifySession(token);

    expect(session).toEqual({ ...payload, issuedAt: expect.any(Number) });
    // The cookie name is part of the web's contract; renaming it signs everyone out.
    expect(SESSION_COOKIE).toBe("pms_session");
  });
});
