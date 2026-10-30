import Link from "next/link";
import { signOutAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/session";

export async function SiteHeader() {
  const session = await getSession();

  return (
    <header className="sticky top-0 z-30 border-b border-cream-200 bg-cream-50/90 backdrop-blur print:hidden">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-teal-700 text-sm font-bold text-white shadow-sm">
            M
          </span>
          <span className="text-lg font-semibold tracking-tight text-ink-900">Medrella</span>
        </Link>

        <nav className="flex items-center gap-1.5">
          <Link
            href="/doctors"
            className="rounded-xl px-2.5 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-cream-100 hover:text-ink-900 sm:px-3"
          >
            <span className="sm:hidden">Doctors</span>
            <span className="hidden sm:inline">Find a doctor</span>
          </Link>

          {session ? (
            <>
              <Link
                href={`/dashboard/${session.role}`}
                className="rounded-xl px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-cream-100 hover:text-ink-900"
              >
                Dashboard
              </Link>
              <span className="hidden text-sm text-ink-500 sm:inline">Hi, {session.name.split(" ")[0]}</span>
              <form action={signOutAction}>
                <Button variant="outline" size="sm" type="submit">
                  Sign out
                </Button>
              </form>
            </>
          ) : (
            <>
              <Link href="/sign-in" aria-label="Sign in">
                <Button variant="ghost" size="sm" type="button">
                  Sign in
                </Button>
              </Link>
              <Link href="/sign-up" aria-label="Create an account">
                <Button size="sm" type="button">
                  Create account
                </Button>
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
