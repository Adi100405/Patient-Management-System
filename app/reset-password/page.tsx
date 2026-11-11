import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth-forms";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Set a new password — Medrella" };

/**
 * The page the emailed link opens. The token in the query string is the
 * credential; it travels with the form and is claimed single-use by the
 * action. A link without its token (a partially copied URL) is refused here;
 * a wrong or spent token is refused by the action with the same generic line.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="mx-auto max-w-md py-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Choose a new password</CardTitle>
          <p className="text-sm text-ink-500">
            Your link proves who you are — set the password you&apos;ll sign in with from now on.
          </p>
        </CardHeader>
        <CardContent>
          {token ? (
            <ResetPasswordForm token={token} />
          ) : (
            <div className="space-y-3 text-sm text-ink-600">
              <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-700">
                This link is missing its token — it may have been copied incompletely.
              </p>
              <Link href="/forgot-password" className="font-medium text-teal-700 hover:underline">
                Request a fresh link
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
