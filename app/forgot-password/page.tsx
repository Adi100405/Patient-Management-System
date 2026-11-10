import { ForgotPasswordForm } from "@/components/auth-forms";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Forgot password — Medrella" };

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto max-w-md py-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Forgot your password?</CardTitle>
          <p className="text-sm text-ink-500">
            Enter the email on your account and we&apos;ll send a link to set a new one.
          </p>
        </CardHeader>
        <CardContent>
          <ForgotPasswordForm />
        </CardContent>
      </Card>

      <div className="mt-4 rounded-xl border border-dashed border-cream-300 bg-cream-50/70 p-4 text-xs text-ink-600">
        <p>The link works once and expires after an hour. If nothing arrives, check spam, or wait a minute and request it again.</p>
      </div>
    </div>
  );
}
