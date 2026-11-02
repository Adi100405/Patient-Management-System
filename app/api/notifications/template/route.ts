import { NextResponse } from "next/server";
import { whatsappStatus } from "@/lib/notifications/channels/twilio";
import {
  WHATSAPP_CONTENT_SID_KEY,
  loadWhatsappSettings,
  saveWhatsappSetting,
} from "@/lib/notifications/settings";
import { getSession } from "@/lib/session";

/**
 * Finds and, if the account allows it, creates the WhatsApp Content Template
 * the clinic sends with.
 *
 * The Content API is the only place a template can be created, and Twilio
 * blocks it on a trial account (`20003`). Rather than guess, this endpoint
 * asks Twilio and reports the answer:
 *
 *   GET  — which template APIs this account can actually read.
 *   POST — creates the appointment template and, when Twilio accepts it, stores
 *          the new sid as the active template so the next send uses it.
 *
 * The template body carries only the two placeholders the app fills in — the
 * visit date and the visit time — and never a patient's details.
 *
 * Doctor-only.
 */
export const dynamic = "force-dynamic";

const TEMPLATE_BODY = "Your appointment is coming up on {{1}} at {{2}}.";

type ProbeResult = {
  endpoint: string;
  status: number | null;
  error: string | null;
  summary: string | null;
};

function twilioAuthHeader(): string | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

/** A short, non-secret description of what an API answered. */
function summarize(body: string): string | null {
  try {
    const payload = JSON.parse(body) as {
      code?: number;
      message?: string;
      contents?: unknown[];
      templates?: unknown[];
      services?: unknown[];
      meta?: { page_size?: number; total?: number; key?: string; next_page_url?: string | null };
    };

    if (typeof payload.code === "number" || payload.message) {
      return `Twilio ${payload.code ?? ""} ${payload.message ?? ""}`.trim();
    }

    const counts = [
      payload.contents?.length ? `contents=${payload.contents.length}` : null,
      payload.templates?.length ? `templates=${payload.templates.length}` : null,
      payload.services?.length ? `services=${payload.services.length}` : null,
    ].filter(Boolean);

    return counts.length ? counts.join(", ") : null;
  } catch {
    return body.slice(0, 160) || null;
  }
}

async function probe(endpoint: string): Promise<ProbeResult> {
  const authorization = twilioAuthHeader();
  if (!authorization) {
    return { endpoint, status: null, error: "Twilio credentials are not configured.", summary: null };
  }

  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const body = await response.text();
    return {
      endpoint,
      status: response.status,
      error: response.ok ? null : summarize(body),
      summary: response.ok ? summarize(body) : null,
    };
  } catch (error) {
    return {
      endpoint,
      status: null,
      error: error instanceof Error ? error.message : "Request failed.",
      summary: null,
    };
  }
}

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "doctor") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const probes = await Promise.all([
    probe("https://content.twilio.com/v1/Content?PageSize=50"),
    probe("https://messaging.twilio.com/v1/Templates?PageSize=50"),
    probe("https://messaging.twilio.com/v1/Senders?PageSize=50"),
    probe("https://messaging.twilio.com/v1/ChannelSenders?PageSize=50"),
  ]);

  const runtime = await loadWhatsappSettings({ force: true });

  return NextResponse.json(
    {
      whatsapp: whatsappStatus(process.env, runtime),
      probes,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST() {
  const session = await getSession();
  if (!session || session.role !== "doctor") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authorization = twilioAuthHeader();
  if (!authorization) {
    return NextResponse.json(
      { error: "Twilio credentials are not configured." },
      { status: 400 },
    );
  }

  try {
    const response = await fetch("https://content.twilio.com/v1/Content", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        friendly_name: "medrella_appointment_reminder",
        language: "en",
        types: {
          whatsapp: {
            body: TEMPLATE_BODY,
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const text = await response.text();
    const payload = JSON.parse(text) as {
      sid?: string;
      friendly_name?: string;
      status?: string;
      code?: number;
      message?: string;
      more_info?: string;
    };

    if (!response.ok || !payload.sid) {
      return NextResponse.json(
        {
          ok: false,
          error: payload.message ?? text.slice(0, 300),
          code: payload.code ?? null,
          moreInfo: payload.more_info ?? null,
        },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }

    // Twilio accepted the template: make it the one the app sends with.
    await saveWhatsappSetting(WHATSAPP_CONTENT_SID_KEY, payload.sid);
    const runtime = await loadWhatsappSettings({ force: true });

    return NextResponse.json(
      {
        ok: true,
        sid: payload.sid,
        friendlyName: payload.friendly_name ?? null,
        status: payload.status ?? null,
        whatsapp: whatsappStatus(process.env, runtime),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "The template request failed.",
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
