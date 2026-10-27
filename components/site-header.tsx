import Link from "next/link";
import { signOutAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/session";

export async function SiteHeader() {
  const session = await getSession();

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-teal-600 text-sm font-bold text-white">
            M
          </span>
          <span className="text-lg font-semibold tracking-tight text-slate-900">Medrella</span>
        </Link>

        <nav className="flex items-center gap-2">
          <Link
            href="/doctors"
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            Find a doctor
          </Link>

          {session ? (
            <>
              <Link
                href={`/dashboard/${session.role}`}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                Dashboard
              </Link>
              <span className="hidden text-sm text-slate-500 sm:inline">Hi, {session.name.split(" ")[0]}</span>
              <form action={signOutAction}>
                <Button variant="outline" size="sm" type="submit">
                  Sign out
                </Button>
              </form>
            </>
          ) : (
            <>
              <Link href="/sign-in">
                <Button variant="ghost" size="sm" type="button">
                  Sign in
                </Button>
              </Link>
              <Link href="/sign-up">
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
