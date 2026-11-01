import { NextResponse } from "next/server";
import { releaseExpiredPayments } from "@/lib/payments/expire";
import { sweepReminders } from "@/lib/notifications/reminders";
import { sweepCareFollowUps } from "@/lib/notifications/care";
import { retryFailedNotifications } from "@/lib/notifications";

/**
 * The daily scheduled sweep. Vercel Cron calls this with
 * `Authorization: Bearer $CRON_SECRET`, and Hobby projects only allow a daily
 * schedule — so this route runs all four sweeps, and three of them are also
 * triggered opportunistically (payment expiry when a doctor's page renders or
 * a checkout opens; reminders and post-visit care when a patient opens their
 * dashboard). The daily run is the backstop that guarantees nothing waits more
 * than a day for a missed trigger.
 *
 *   1. Release slots held by checkouts that were abandoned past their hold.
 *   2. Send appointment reminders that have come due.
 *   3. Send post-visit care messages (thank-you, follow-up prompt) that are due.
 *   4. Retry notifications whose backoff has elapsed.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Independent sweeps: a failure in one is reported, not allowed to mask the
  // result of the others (or to arrive as a bare 500 with no detail).
  const released = await releaseExpiredPayments().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "expiry sweep failed",
  }));
  const reminders = await sweepReminders().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "reminder sweep failed",
  }));
  const care = await sweepCareFollowUps().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "care sweep failed",
  }));
  const retries = await retryFailedNotifications().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "notification retry failed",
  }));
  return NextResponse.json({ released, reminders, care, retries });
}
