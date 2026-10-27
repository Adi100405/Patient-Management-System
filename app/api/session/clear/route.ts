import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/jwt";

/**
 * Clears an invalid session cookie and returns the user to the sign-in page.
 * Cookie writes are only allowed in Server Actions and Route Handlers, so the
 * dashboard guards redirect here instead of deleting the cookie during render.
 */
export async function GET(request: Request) {
  const store = await cookies();
  store.delete(SESSION_COOKIE);

  return NextResponse.redirect(new URL("/sign-in?expired=1", request.url));
}
