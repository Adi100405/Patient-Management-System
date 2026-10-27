import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { doctors, patients } from "@/db/schema";
import {
  SESSION_COOKIE,
  signSession,
  verifySession,
  type SessionPayload,
} from "./jwt";

export type { SessionPayload };

export async function createSession(payload: SessionPayload) {
  const token = await signSession(payload);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

/**
 * Guards a dashboard page and confirms the profile behind the token still exists.
 * A session whose doctor/patient row was deleted (for example after a database
 * reseed) is cleared instead of rendering an empty "ghost" dashboard.
 */
export async function requireRole(role: "patient" | "doctor") {
  const session = await requireSession();
  if (session.role !== role) {
    redirect(`/dashboard/${session.role}`);
  }

  const db = getDb();
  const rows =
    role === "doctor"
      ? await db
          .select({ id: doctors.id })
          .from(doctors)
          .where(eq(doctors.id, session.profileId))
          .limit(1)
      : await db
          .select({ id: patients.id })
          .from(patients)
          .where(eq(patients.id, session.profileId))
          .limit(1);

  if (rows.length === 0) {
    // Cookie writes are not allowed while rendering, so a route handler clears
    // the stale session before sending the user back to sign in.
    redirect("/api/session/clear");
  }

  return session;
}
