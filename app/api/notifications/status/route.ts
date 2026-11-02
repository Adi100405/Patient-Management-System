import { NextResponse } from "next/server";
import { createResendChannel } from "@/lib/notifications/channels/resend";
import {
  normalizeContentSid,
  whatsappStatus,
} from "@/lib/notifications/channels/twilio";
import { loadWhatsappSettings } from "@/lib/notifications/settings";
import { getSession } from "@/lib/session";

/**
 * Operator view of the notification transports a deployment can actually see.
 *
 * This exists because "the message was skipped" is indistinguishable from "the
 * provider was unconfigured" and "the env var never reached this build" once
 * you are looking at the app from the outside. A doctor can open
 * `/api/notifications/status` after a deploy and read the truth; `?probe=1`
 * additionally asks Twilio whether the Content Template sid exists on this
 * account.
 *
 * Nothing secret is returned: booleans, the environment's commit, and the last
 * four characters of the template sid. Twilio credentials never leave the
 * server. It is doctor-only because integration health is not patient data.
 */
export const dynamic = "force-dynamic";

type TemplateProbe =
  | { ok: true; friendlyName: string | null; language: string | null; types: string[] }
  | { ok: false; status?: number; error: string };

type TemplateList =
  | {
      ok: true;
      templates: Array<{
        sid: string;
        friendlyName: string | null;
        language: string | null;
        whatsapp: boolean;
        types: string[];
      }>;
    }
  | { ok: false; status?: number; error: string };

function twilioAuthHeader(): string | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

async function probeTemplate(sid: string): Promise<TemplateProbe> {
  const authorization = twilioAuthHeader();
  if (!authorization) {
    return { ok: false, error: "Twilio credentials are not configured." };
  }

  try {
    const response = await fetch(
      `https://content.twilio.com/v1/Content/${encodeURIComponent(sid)}`,
      {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      },
    );
    const body = await response.text();

    if (!response.ok) {
      return { ok: false, status: response.status, error: body.slice(0, 300) };
    }

    const payload = JSON.parse(body) as {
      friendly_name?: string;
      language?: string;
      types?: Record<string, unknown>;
    };
    return {
      ok: true,
      friendlyName: payload.friendly_name ?? null,
      language: payload.language ?? null,
      types: Object.keys(payload.types ?? {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Twilio content lookup failed.",
    };
  }
}

/** Read-only discovery: every template sid this account owns, never a secret. */
async function listTemplates(): Promise<TemplateList> {
  const authorization = twilioAuthHeader();
  if (!authorization) {
    return { ok: false, error: "Twilio credentials are not configured." };
  }

  try {
    const response = await fetch("https://content.twilio.com/v1/Content?PageSize=50", {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    const body = await response.text();

    if (!response.ok) {
      return { ok: false, status: response.status, error: body.slice(0, 300) };
    }

    const payload = JSON.parse(body) as {
      contents?: Array<{
        sid?: string;
        friendly_name?: string;
        language?: string;
        types?: Record<string, unknown>;
      }>;
    };

    return {
      ok: true,
      templates: (payload.contents ?? []).flatMap((item) => {
        if (!item.sid) return [];
        const types = Object.keys(item.types ?? {});
        return [
          {
            sid: item.sid,
            friendlyName: item.friendly_name ?? null,
            language: item.language ?? null,
            whatsapp: types.some((type) => type.startsWith("whatsapp/")),
            types,
          },
        ];
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Twilio content list failed.",
    };
  }
}

type RecentMessage = {
  sid: string;
  /** Masked: the operator needs the direction, not the patient's number. */
  from: string | null;
  to: string | null;
  direction: string | null;
  status: string | null;
  errorCode: number | null;
  /** The template Twilio accepted for this message, when one was used. */
  contentSid: string | null;
  dateCreated: string | null;
};

type MessageList =
  | { ok: true; messages: RecentMessage[] }
  | { ok: false; status?: number; error: string };

type ServiceList =
  | {
      ok: true;
      services: Array<{ sid: string; friendlyName: string | null }>;
    }
  | { ok: false; status?: number; error: string };

/** Keep the channel prefix and the last four digits; hide the rest. */
function maskNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const prefix = value.startsWith("whatsapp:") ? "whatsapp:" : "";
  const digits = value.slice(prefix.length);
  if (digits.length <= 4) return `${prefix}${"*".repeat(digits.length)}`;
  return `${prefix}${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Twilio's own message log. When the app sends a template, Twilio records the
 * `ContentSid` it accepted on that message — which is the one reliable way to
 * learn a template sid this account owns without the Content API (a trial
 * account cannot read that API).
 */
async function listRecentMessages(): Promise<MessageList> {
  const authorization = twilioAuthHeader();
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!authorization || !accountSid) {
    return { ok: false, error: "Twilio credentials are not configured." };
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json?PageSize=50`,
      {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(8_000),
        cache: "no-store",
      },
    );
    const body = await response.text();

    if (!response.ok) {
      return { ok: false, status: response.status, error: body.slice(0, 300) };
    }

    const payload = JSON.parse(body) as {
      messages?: Array<{
        sid?: string;
        from?: string | null;
        to?: string | null;
        direction?: string | null;
        status?: string | null;
        error_code?: number | null;
        content_sid?: string | null;
        contentSid?: string | null;
        date_created?: string | null;
      }>;
    };

    return {
      ok: true,
      messages: (payload.messages ?? []).flatMap((message) => {
        if (!message.sid) return [];
        return [
          {
            sid: message.sid,
            from: maskNumber(message.from),
            to: maskNumber(message.to),
            direction: message.direction ?? null,
            status: message.status ?? null,
            errorCode: message.error_code ?? null,
            contentSid: message.content_sid ?? message.contentSid ?? null,
            dateCreated: message.date_created ?? null,
          },
        ];
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Twilio message log failed.",
    };
  }
}

/** Messaging services on the account — a template send may need one. */
async function listServices(): Promise<ServiceList> {
  const authorization = twilioAuthHeader();
  if (!authorization) {
    return { ok: false, error: "Twilio credentials are not configured." };
  }

  try {
    const response = await fetch(
      "https://messaging.twilio.com/v1/Services?PageSize=20",
      {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(8_000),
        cache: "no-store",
      },
    );
    const body = await response.text();

    if (!response.ok) {
      return { ok: false, status: response.status, error: body.slice(0, 300) };
    }

    const payload = JSON.parse(body) as {
      services?: Array<{ sid?: string; friendly_name?: string | null }>;
    };

    return {
      ok: true,
      services: (payload.services ?? []).flatMap((service) =>
        service.sid
          ? [{ sid: service.sid, friendlyName: service.friendly_name ?? null }]
          : [],
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Twilio service list failed.",
    };
  }
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "doctor") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const whatsapp = whatsappStatus(process.env, await loadWhatsappSettings({ force: true }));
  const params = new URL(request.url).searchParams;
  const probeRequested = params.get("probe") === "1";
  const templatesRequested = params.get("templates") === "1";
  const messagesRequested = params.get("messages") === "1";
  const servicesRequested = params.get("services") === "1";
  const sid = normalizeContentSid(process.env.TWILIO_WHATSAPP_CONTENT_SID);

  return NextResponse.json(
    {
      deployment: {
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      },
      channels: {
        email: { transport: createResendChannel() ? "resend" : "log" },
        sms: { configured: Boolean(process.env.TWILIO_FROM) },
        whatsapp,
      },
      mobileChannel: whatsapp.configured ? "whatsapp" : "sms",
      template:
        probeRequested && sid
          ? await probeTemplate(sid)
          : probeRequested
            ? { ok: false, error: "No valid Content Template sid is configured." }
            : null,
      templates: templatesRequested ? await listTemplates() : null,
      messages: messagesRequested ? await listRecentMessages() : null,
      services: servicesRequested ? await listServices() : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
