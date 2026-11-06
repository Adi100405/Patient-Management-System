"use server";

import { and, desc, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  availability,
  doctors,
  passwordResetTokens,
  patients,
  users,
} from "@/db/schema";
import {
  fieldErrors,
  forgotPasswordSchema,
  hashPassword,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  verifyPassword,
} from "@/lib/auth";
import {
  RESET_REQUEST_COOLDOWN_MS,
  RESET_TOKEN_TTL_MINUTES,
  createResetToken,
  hashResetToken,
  isTokenUsable,
  tokenExpiresAt,
} from "@/lib/password";
import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "@/lib/notifications/events";
import { resetPasswordUrl } from "@/lib/notifications/links";
import { createSession, destroySession } from "@/lib/session";

export type AuthState = {
  error?: string;
  errors?: Record<string, string>;
  /** A confirmation the form shows no matter what the request was (validation aside). */
  message?: string;
} | null;

/** The one sentence the forgot form shows, account or no account: confirming
 * which emails have accounts is exactly what a public reset form must not do. */
const RESET_REQUEST_ACCEPTED =
  "If an account exists for that email, a reset link is on its way. It expires in one hour.";

export async function forgotPasswordAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = forgotPasswordSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const email = parsed.data.email.toLowerCase();
  const db = getDb();
  const now = new Date();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (user) {
    const [recentRequest] = await db
      .select({ createdAt: passwordResetTokens.createdAt })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id))
      .orderBy(desc(passwordResetTokens.createdAt))
      .limit(1);

    // Used or not, a mint counts: the cooldown throttles the mailer for the
    // account, so the form cannot be a mailer bomb in a loop.
    const coolingDown =
      recentRequest != null &&
      now.getTime() - recentRequest.createdAt.getTime() < RESET_REQUEST_COOLDOWN_MS;

    if (!coolingDown) {
      const token = createResetToken();

      // Latest request wins: minting a link deletes the account's older rows,
      // so an inbox can hold at most one live credential at a time.
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
      await db.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt: tokenExpiresAt(now),
      });

      // Even if this send fails, the notify ledger keeps the row and its
      // sweep retries — and the generic sentence below gets sent regardless.
      await sendPasswordResetEmail(email, resetPasswordUrl(token), {
        expiryMinutes: RESET_TOKEN_TTL_MINUTES,
      });
    }
  }

  return { message: RESET_REQUEST_ACCEPTED };
}

/** Every reason a link cannot change a password becomes this same line: a
 * wrong link is an attack surface, and why it failed tells nothing useful. */
const RESET_LINK_DEAD =
  "This reset link is no longer valid. Request a fresh link from the forgot-password page.";

export async function resetPasswordAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = resetPasswordSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const db = getDb();
  const now = new Date();
  const tokenHash = hashResetToken(parsed.data.token);

  const [request] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  if (!request || !isTokenUsable(request, now)) {
    return { error: RESET_LINK_DEAD };
  }

  // The single-use claim, in one conditional update: `used_at` is set only
  // for a row that is still unspent. Two tabs racing one link, a double
  // click, or a replayed submission therefore resolve to exactly one granted
  // password change — everyone else is told the link died.
  const claimed = await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(and(eq(passwordResetTokens.id, request.id), isNull(passwordResetTokens.usedAt)))
    .returning({ id: passwordResetTokens.id });

  if (claimed.length === 0) {
    return { error: RESET_LINK_DEAD };
  }

  // `passwordChangedAt` is the ledger the session guard reads: every session
  // issued before this instant loses its right to act on the account.
  const [user] = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(parsed.data.password),
      passwordChangedAt: now,
    })
    .where(eq(users.id, request.userId))
    .returning({ email: users.email });

  if (!user) {
    // The account vanished mid-flight (its cascade would already have removed
    // the token). Nothing was changed by us, so the link simply reads dead.
    return { error: RESET_LINK_DEAD };
  }

  await sendPasswordChangedEmail(user.email);
  redirect("/sign-in?reset=1");
}

export async function signUpAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const data = parsed.data;
  const email = data.email.toLowerCase();
  const db = getDb();

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return { error: "An account with that email already exists." };
  }

  const passwordHash = await hashPassword(data.password);

  const [user] = await db
    .insert(users)
    .values({ email, passwordHash, role: data.role })
    .returning({ id: users.id });

  if (!user) return { error: "Could not create the account. Please try again." };

  let profileId: number;

  if (data.role === "doctor") {
    if (!data.specialization) {
      return { errors: { specialization: "Specialization is required for doctors" } };
    }
    const [doctor] = await db
      .insert(doctors)
      .values({
        userId: user.id,
        fullName: data.name,
        specialization: data.specialization,
        experienceYears: Number(data.experienceYears ?? 0) || 0,
        consultationFee: String(Number(data.consultationFee ?? 500) || 500),
      })
      .returning({ id: doctors.id });
    if (!doctor) return { error: "Could not create the doctor profile." };

    // A new doctor starts with a Mon–Fri morning schedule so their profile is
    // bookable straight away; they can edit it from the dashboard.
    await db.insert(availability).values(
      [1, 2, 3, 4, 5].map((day) => ({
        doctorId: doctor.id,
        dayOfWeek: day,
        startTime: "09:00",
        endTime: "13:00",
        slotMinutes: 30,
      })),
    );

    profileId = doctor.id;
  } else {
    const [patient] = await db
      .insert(patients)
      .values({ userId: user.id, fullName: data.name, phone: data.phone })
      .returning({ id: patients.id });
    if (!patient) return { error: "Could not create the patient profile." };
    profileId = patient.id;
  }

  await createSession({ userId: user.id, role: data.role, name: data.name, profileId });
  redirect(`/dashboard/${data.role}`);
}

export async function signInAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const email = parsed.data.email.toLowerCase();
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return { error: "Incorrect email or password." };
  }

  if (user.role === "doctor") {
    const [doctor] = await db.select().from(doctors).where(eq(doctors.userId, user.id)).limit(1);
    if (!doctor) return { error: "Doctor profile is missing. Please contact support." };
    await createSession({
      userId: user.id,
      role: "doctor",
      name: doctor.fullName,
      profileId: doctor.id,
    });
    redirect("/dashboard/doctor");
  }

  const [patient] = await db.select().from(patients).where(eq(patients.userId, user.id)).limit(1);
  if (!patient) return { error: "Patient profile is missing. Please contact support." };
  await createSession({
    userId: user.id,
    role: "patient",
    name: patient.fullName,
    profileId: patient.id,
  });
  redirect("/dashboard/patient");
}

export async function signOutAction() {
  await destroySession();
  redirect("/");
}
