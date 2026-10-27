"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { doctors, patients, users } from "@/db/schema";
import {
  fieldErrors,
  hashPassword,
  signInSchema,
  signUpSchema,
  verifyPassword,
} from "@/lib/auth";
import { createSession, destroySession } from "@/lib/session";

export type AuthState = {
  error?: string;
  errors?: Record<string, string>;
} | null;

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
