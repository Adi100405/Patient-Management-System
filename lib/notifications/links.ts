/**
 * Absolute links for emails. A message is rendered on whichever server handled
 * the event but opened somewhere else entirely, so a relative path would be
 * meaningless in an inbox; the destination is resolved from the environment.
 *
 *   APP_URL      — explicit public origin, e.g. https://medrella.example.com
 *   VERCEL_URL   — set by Vercel to the deployment host (no scheme), so preview
 *                  deployments link to themselves
 *   localhost    — the fallback that keeps local dev clickable
 */
export function appBaseUrl(): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  return "http://localhost:3000";
}

/** The patient dashboard: the one page that can answer "what now?". */
export function dashboardUrl(): string {
  return `${appBaseUrl()}/dashboard/patient`;
}

/** A single printable receipt for a settled payment. */
export function receiptUrl(paymentId: number): string {
  return `${appBaseUrl()}/dashboard/patient/receipts/${paymentId}`;
}
