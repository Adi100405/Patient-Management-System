"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { signInAction, signUpAction, type AuthState } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-rose-600">{message}</p>;
}

export function SignInForm() {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(signInAction, null);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{state.error}</p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
        <FieldError message={state?.errors?.email} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <FieldError message={state?.errors?.password} />
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>

      <p className="text-center text-sm text-ink-600">
        New here?{" "}
        <Link href="/sign-up" className="font-medium text-teal-700 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm() {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(signUpAction, null);
  const [role, setRole] = useState<"patient" | "doctor">("patient");

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{state.error}</p>
      )}

      <div className="space-y-1.5">
        <Label>I am a</Label>
        <div className="grid grid-cols-2 gap-2">
          {(["patient", "doctor"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRole(option)}
              className={`h-11 rounded-xl border px-3 text-sm font-medium capitalize transition-colors ${
                role === option
                  ? "border-teal-700 bg-teal-50 text-teal-800"
                  : "border-cream-300 bg-white text-ink-700 hover:bg-cream-100"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <input type="hidden" name="role" value={role} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="name">Full name</Label>
        <Input id="name" name="name" required />
        <FieldError message={state?.errors?.name} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
        <FieldError message={state?.errors?.email} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          required
        />
        <FieldError message={state?.errors?.password} />
      </div>

      {role === "doctor" ? (
        <div className="space-y-4 rounded-xl border border-cream-200 bg-cream-50/70 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Doctor details
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="specialization">Specialization</Label>
            <Input
              id="specialization"
              name="specialization"
              placeholder="e.g. Cardiology"
              required={role === "doctor"}
            />
            <FieldError message={state?.errors?.specialization} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="experienceYears">Experience (years)</Label>
              <Input id="experienceYears" name="experienceYears" type="number" min={0} defaultValue={5} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="consultationFee">Fee (₹)</Label>
              <Input id="consultationFee" name="consultationFee" type="number" min={0} defaultValue={500} />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone (optional)</Label>
          <Input id="phone" name="phone" type="tel" placeholder="+91 98765 43210" />
        </div>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </Button>

      <p className="text-center text-sm text-ink-600">
        Already registered?{" "}
        <Link href="/sign-in" className="font-medium text-teal-700 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
