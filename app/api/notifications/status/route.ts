import { NextResponse } from "next/server";
import { createResendChannel } from "@/lib/notifications/channels/resend";
import { smsStatus } from "@/lib/notifications/channels/sms";
import { getSession } from "@/lib/session";

/**
 * Operator view of the notification transports a deployment can actually see.
 *
 * This exists because "the message was skipped" is indistinguishable from "the
 * provider was unconfigured" and "the env var never reached this build" once
 * you are looking at the app from the outside. A doctor can open
 * `/api/notifications/status` after a deploy and read the truth.
 *
 * Nothing secret is returned: booleans, the environment's commit, and the last
 * four digits of the SMS sender. Provider credentials never leave the server.
 * It is doctor-only because integration health is not patient data.
 */
export const dynamic = "force-dynamic";

function twilioAuthHeader(): string | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

type RecentMessage = {
  sid: string;
  /** Masked: the operator needs the direction, not the patient's number. */
  from: string | null;
  to: string | null;
  direction: string | null;
  status: string | null;
  errorCode: number | null;
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

/** Keep the last four digits; hide the rest. */
function maskNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * Twilio's own message log — the operator's view of what the SMS transport
 * actually handed to the provider.
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

  const params = new URL(request.url).searchParams;
  const messagesRequested = params.get("messages") === "1";
  const servicesRequested = params.get("services") === "1";

  return NextResponse.json(
    {
      deployment: {
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      },
      channels: {
        email: { transport: createResendChannel() ? "resend" : "log" },
        // Was it the env var or the provider? The sender's last four digits
        // answer that without exposing the number.
        sms: smsStatus(process.env),
      },
      mobileChannel: "sms",
      messages: messagesRequested ? await listRecentMessages() : null,
      services: servicesRequested ? await listServices() : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
