import { NextResponse } from "next/server";
import { createSmsChannel, smsStatus } from "@/lib/notifications/channels/sms";
import {
  normalizeContentSid,
  whatsappConfig,
} from "@/lib/notifications/channels/twilio";
import { loadWhatsappSettings } from "@/lib/notifications/settings";
import { getSession } from "@/lib/session";

/**
 * Sends one test message on demand, so a doctor can prove that *this
 * deployment* can reach Twilio without waiting for a patient to book.
 *
 * `channel` defaults to `whatsapp`; `sms` sends through the same transport the
 * appointment events use, which means it also honours a trial account's
 * predefined-template fallback and reports it as `degraded: true` rather than
 * pretending the clinic's text went out.
 *
 * For WhatsApp it is deliberately an action, not a status read: it POSTs to
 * Twilio and reports exactly what Twilio said. The message carries the same two
 * placeholders the app's appointment templates use (visit date, visit time) and
 * nothing else — no patient name, no reason, no other health information. The
 * SMS body is a neutral sentence or the caller's own `text`, never patient data.
 *
 * `from` is optional and applies to WhatsApp only: it defaults to the configured
 * sender. Overriding it is useful on a trial account, where a template can be
 * valid only from a particular sender (the Sandbox number, for instance), and
 * it lets an operator compare senders without redeploying. The SMS transport
 * reads its sender from the deployment's configuration.
 *
 * Doctor-only: this spends the account's trial message quota, so it must not be
 * callable by a patient.
 */
export const dynamic = "force-dynamic";

type SendRequest = {
  channel?: "sms" | "whatsapp";
  to?: string;
  from?: string;
  /**
   * A candidate Content Template sid, tried without being stored. It lets an
   * operator check a sid from the Twilio console before activating it.
   */
  contentSid?: string;
  /** SMS only: the body to try. A neutral test sentence by default. */
  text?: string;
  /** SMS only: which event the body stands in for, so the trial mapping matches. */
  kind?: string;
};

const DEFAULT_SMS_TEXT = "Medrella test SMS: this deployment can reach Twilio.";

function withWhatsappPrefix(value: string): string {
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "doctor") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as SendRequest | null;

  // SMS goes through the notification transport itself, so a test exercises
  // the same trial handling a real appointment message would get.
  if (body?.channel === "sms") {
    return sendTestSms(body);
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const runtime = await loadWhatsappSettings({ force: true });
  const config = whatsappConfig(process.env, runtime);

  const candidate = body?.contentSid ? normalizeContentSid(body.contentSid.trim()) : null;
  if (body?.contentSid && !candidate) {
    return NextResponse.json(
      {
        error:
          "That is not a Content Template sid. It must look like HX followed by 32 hex characters.",
      },
      { status: 400 },
    );
  }

  const contentSid = candidate ?? config.contentSid;
  if (!accountSid || !authToken || !contentSid) {
    return NextResponse.json(
      { error: "Twilio WhatsApp is not configured on this deployment." },
      { status: 400 },
    );
  }

  const to = body?.to?.trim();
  if (!to) {
    return NextResponse.json(
      { error: "A recipient `to` (E.164) is required." },
      { status: 400 },
    );
  }

  const from = body?.from?.trim() || config.sender;
  if (!from) {
    return NextResponse.json(
      { error: "No WhatsApp sender is configured; pass `from` explicitly." },
      { status: 400 },
    );
  }

  const form = new URLSearchParams({
    To: withWhatsappPrefix(to),
    From: withWhatsappPrefix(from),
    ContentSid: contentSid,
    ContentVariables: JSON.stringify({ "1": "5 Nov 2026", "2": "10:30" }),
  });

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      },
    );
    const text = await response.text();
    const payload = JSON.parse(text) as {
      sid?: string;
      status?: string;
      error_code?: number;
      message?: string;
      body?: string;
    };

    return NextResponse.json(
      {
        ok: response.ok,
        httpStatus: response.status,
        messageSid: payload.sid ?? null,
        status: payload.status ?? null,
        errorCode: payload.error_code ?? null,
        error: payload.message ?? null,
        rendered: payload.body ?? null,
      },
      { status: response.ok ? 200 : 502, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "The Twilio request failed.",
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

/**
 * One SMS through the real transport. On a trial Twilio account the free-form
 * body is refused (`572006`) and the transport retries with a predefined
 * template; the answer says so instead of implying the clinic's text was
 * delivered. Vonage carries the text as written and never degrades.
 */
async function sendTestSms(body: SendRequest) {
  const status = smsStatus(process.env);
  if (!status.configured) {
    return NextResponse.json(
      {
        error:
          "SMS is not configured on this deployment. It needs Vonage (VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_FROM) or Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM).",
      },
      { status: 400 },
    );
  }

  const to = body.to?.trim();
  if (!to) {
    return NextResponse.json(
      { error: "A recipient `to` (E.164) is required." },
      { status: 400 },
    );
  }

  const channel = createSmsChannel();
  if (!channel) {
    return NextResponse.json(
      { error: "No SMS transport is configured on this deployment." },
      { status: 400 },
    );
  }

  try {
    const result = await channel.send({
      to,
      subject: "",
      text: body.text?.trim() || DEFAULT_SMS_TEXT,
      meta: { kind: body.kind?.trim() || "diagnostic" },
    });

    return NextResponse.json(
      {
        ok: true,
        channel: "sms",
        provider: status.provider,
        messageSid: result?.providerRef ?? null,
        /** Twilio's predefined template, when the trial account forced one. */
        trialTemplate: result?.trialTemplate ?? null,
        degraded: Boolean(result?.trialTemplate),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        channel: "sms",
        provider: status.provider,
        error: error instanceof Error ? error.message : "The SMS request failed.",
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
