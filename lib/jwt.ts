import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "pms_session";

export type SessionPayload = {
  userId: number;
  role: "patient" | "doctor";
  name: string;
  profileId: number;
};

function secretKey() {
  const secret = process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me";
  return new TextEncoder().encode(secret);
}

export async function signSession(payload: SessionPayload) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (
      typeof payload.userId === "number" &&
      typeof payload.profileId === "number" &&
      (payload.role === "patient" || payload.role === "doctor") &&
      typeof payload.name === "string"
    ) {
      return {
        userId: payload.userId,
        role: payload.role,
        name: payload.name,
        profileId: payload.profileId,
      };
    }
    return null;
  } catch {
    return null;
  }
}
