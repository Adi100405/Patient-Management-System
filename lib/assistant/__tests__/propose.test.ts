import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  consumeProposal,
  signProposal,
  verifyProposal,
  type ProposalClaims,
} from "@/lib/assistant/propose";

const TEST_SECRET = "assistant-proposal-test-secret";

function key() {
  return new TextEncoder().encode(TEST_SECRET);
}

const claims: ProposalClaims = {
  action: "book",
  args: { doctorId: 4, availabilityId: 9, date: "2026-11-12", time: "10:30" },
  userId: 17,
  role: "patient",
};

beforeAll(() => {
  process.env.ASSISTANT_PROPOSAL_SECRET = TEST_SECRET;
});

afterAll(() => {
  delete process.env.ASSISTANT_PROPOSAL_SECRET;
});

describe("proposal tokens", () => {
  it("round-trips the action, arguments and identity that Confirm will use", async () => {
    const signed = await signProposal(claims);

    const verified = await verifyProposal(signed.token);

    expect(verified).not.toBeNull();
    expect(verified?.action).toBe("book");
    expect(verified?.args).toEqual(claims.args);
    expect(verified?.userId).toBe(17);
    expect(verified?.role).toBe("patient");
    expect(verified?.id).toBe(signed.id);
    // jose stamps `exp` in whole seconds; the display time must be the same
    // instant, so the card cannot grey out later than the server refuses.
    expect(verified?.expiresAt).toBe(signed.expiresAt);
  });

  it("refuses a token whose payload was edited after signing", async () => {
    const signed = await signProposal(claims);
    const [header, payload, signature] = signed.token.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    decoded.userId = 99;
    const forged = [
      header,
      Buffer.from(JSON.stringify(decoded)).toString("base64url"),
      signature,
    ].join(".");

    expect(await verifyProposal(forged)).toBeNull();
  });

  it("refuses a token that has already expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256" })
      .setJti("expired-id")
      .setIssuedAt(now - 600)
      .setExpirationTime(now - 60)
      .sign(key());

    expect(await verifyProposal(expired)).toBeNull();
  });

  it("refuses a randomly malformed token instead of throwing", async () => {
    expect(await verifyProposal("not-a-jwt")).toBeNull();
  });

  it("spends an id exactly once, so a double-tapped card cannot write twice", () => {
    const expiresAt = Date.now() + 60_000;

    expect(consumeProposal("jti-once", expiresAt)).toBe(true);
    expect(consumeProposal("jti-once", expiresAt)).toBe(false);
  });

  it("lets a different proposal through after one has been spent", () => {
    const expiresAt = Date.now() + 60_000;

    expect(consumeProposal("jti-a", expiresAt)).toBe(true);
    expect(consumeProposal("jti-b", expiresAt)).toBe(true);
  });
});
