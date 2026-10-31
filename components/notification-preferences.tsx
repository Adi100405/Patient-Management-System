"use client";

import { useActionState } from "react";
import { updateNotificationPreferences, type PreferencesState } from "@/actions/notifications";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type InitialPreferences = {
  emailEnabled: boolean;
  smsEnabled: boolean;
  smsConsented: boolean;
  marketingOptIn: boolean;
  phone: string;
};

const checkboxClass =
  "mt-0.5 h-4 w-4 shrink-0 rounded border-cream-300 text-teal-700 accent-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600";

function Row({
  name,
  defaultChecked,
  title,
  description,
}: {
  name: string;
  defaultChecked: boolean;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-cream-200 bg-cream-50/60 p-3.5 transition-colors hover:border-cream-300">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className={checkboxClass} />
      <span>
        <span className="block text-sm font-medium text-ink-900">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{description}</span>
      </span>
    </label>
  );
}

/**
 * Per-patient communication choices. The server action re-validates every
 * rule (one channel must stay reachable, SMS needs a number plus consent), so
 * this form stays a thin client over the real gate in
 * `lib/notifications/preferences.ts`.
 */
export function NotificationPreferences({ initial }: { initial: InitialPreferences }) {
  const [state, formAction, pending] = useActionState<PreferencesState, FormData>(
    updateNotificationPreferences,
    null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification preferences</CardTitle>
        <p className="text-sm text-ink-500">
          How we reach you about bookings, changes and payments. Appointment updates always remain
          visible on this dashboard.
        </p>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Row
              name="emailEnabled"
              defaultChecked={initial.emailEnabled}
              title="Email updates"
              description="Confirmations, cancellations, reschedules and payment/refund updates to your sign-in email."
            />
            <Row
              name="smsEnabled"
              defaultChecked={initial.smsEnabled}
              title="Mobile updates"
              description="Short messages by SMS or WhatsApp for bookings, changes and appointment reminders."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="notification-phone">Mobile number</Label>
              <Input
                id="notification-phone"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+919876543210"
                defaultValue={initial.phone}
              />
              <p className="text-xs text-ink-500">
                With country code, e.g. +919876543210. Used only for the messages you opt into.
              </p>
            </div>
            <div className="space-y-3">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  name="smsConsent"
                  defaultChecked={initial.smsConsented}
                  className={checkboxClass}
                />
                <span className="text-xs leading-relaxed text-ink-600">
                  I agree to receive service messages about my appointments by SMS or WhatsApp.
                  Turning mobile updates on records the date of this tick as the moment of consent.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  name="marketingOptIn"
                  defaultChecked={initial.marketingOptIn}
                  className={checkboxClass}
                />
                <span className="text-xs leading-relaxed text-ink-600">
                  Optionally, keep me posted about Medrella offers and health camps. Appointment
                  messages never depend on this.
                </span>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save preferences"}
            </Button>
            {state?.message && (
              <p className="text-xs font-medium text-teal-700" role="status">
                {state.message}
              </p>
            )}
            {state?.error && (
              <p className="text-xs font-medium text-rose-600" role="alert">
                {state.error}
              </p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
