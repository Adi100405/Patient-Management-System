import { SignJWT, jwtVerify } from "jose";
import type { ProposalAction, AssistantRole } from "./types";

/**
 * Proposal tokens: the assistant's only bridge from "the model suggested
 * something" to "the platform is allowed to write".
 *
 * The model never writes. A write tool returns a signed token carrying the
 * action, its arguments and the identity of the person who asked. The browser
 * shows a confirmation card; when the person taps Confirm, the confirm endpoint
 * verifies the token (signature, expiry, identity) and only then calls the real
 * server action, which re-validates everything again — seat index included.
 *
 * Properties the security model relies on:
 *   - HS256 signature over a server-only secret, so the browser cannot mint or
 *     edit a proposal;
 *   - five-minute expiry, so a stale confirmation cannot be replayed later;
 *   - a random `jti` kept in a single-use set, so one card can never execute
 *     twice even if the button is double-tapped;
 *   - the identity is inside the signed payload and compared against the
 *     session, so a token minted for one account cannot be used by another.
 */
const TTL_SECONDS = 5 * 60;

function proposalKey(): Uint8Array {
  const secret =
    process.env.ASSISTANT_PROPOSAL_SECRET ??
    process.env.SESSION_SECRET ??
    "dev-only-insecure-secret-change-me";
  return new TextEncoder().encode(secret);
}

export type ProposalClaims = {
  readonly action: ProposalAction;
  readonly args: Record<string, unknown>;
  readonly userId: number;
  readonly role: AssistantRole;
};

export type SignedProposal = {
  readonly token: string;
  readonly id: string;
  /** Epoch milliseconds, for display only; the token's `exp` is the truth. */
  readonly expiresAt: number;
};

export async function signProposal(claims: ProposalClaims): Promise<SignedProposal> {
  const id = crypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    action: claims.action,
    args: claims.args,
    userId: claims.userId,
    role: claims.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + TTL_SECONDS)
    .sign(proposalKey());

  return { token, id, expiresAt: (issuedAt + TTL_SECONDS) * 1000 };
}

export type VerifiedProposal = ProposalClaims & {
  readonly id: string;
  readonly expiresAt: number;
};

export async function verifyProposal(token: string): Promise<VerifiedProposal | null> {
  try {
    const { payload } = await jwtVerify(token, proposalKey());

    if (payload.action !== "book" && payload.action !== "reschedule" && payload.action !== "cancel") {
      return null;
    }
    if (payload.role !== "patient" && payload.role !== "doctor") return null;
    if (typeof payload.userId !== "number") return null;
    if (typeof payload.jti !== "string") return null;
    if (typeof payload.exp !== "number") return null;
    if (
      !payload.args ||
      typeof payload.args !== "object" ||
      Array.isArray(payload.args)
    ) {
      return null;
    }

    return {
      action: payload.action,
      args: payload.args as Record<string, unknown>,
      userId: payload.userId,
      role: payload.role,
      id: payload.jti,
      expiresAt: payload.exp * 1000,
    };
  } catch {
    // Bad signature, malformed token, expired token: all indistinguishable to
    // the caller, and all refused the same way.
    return null;
  }
}

/**
 * Single-use registry. In memory on purpose: a proposal lives for five minutes
 * and a server restart invalidating every outstanding card is the safe failure
 * direction. Expired ids are pruned on each call so the map cannot grow without
 * bound.
 */
const usedProposals = new Map<string, number>();

export function consumeProposal(id: string, expiresAt: number): boolean {
  const now = Date.now();
  for (const [key, expiry] of usedProposals) {
    if (expiry < now) usedProposals.delete(key);
  }
  if (usedProposals.has(id)) return false;
  usedProposals.set(id, expiresAt);
  return true;
}
