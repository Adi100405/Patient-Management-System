import { NextResponse } from "next/server";
import { createSmsChannel, smsStatus } from "@/lib/notifications/channels/sms";
import { getSession } from "@/lib/session";

/**
 * Sends one test SMS on demand, so a doctor can prove that *this deployment*
 * can reach the patient without waiting for a real booking.
 *
 * The message goes through the same transport the appointment events use, so a
 * test exercises the same provider handling a real appointment message would
 * get — including a trial Twilio account's predefined-template fallback, which
 * is reported as `degraded: true` rather than pretending the clinic's text
 * went out.
 *
 * The body is a neutral sentence or the caller's own `text`, never patient
 * data.
 *
 * Doctor-only: this spends the account's message quota, so it must not be
 * callable by a patient.
 */
export const dynamic = "force-dynamic";

type SendRequest = {
  /** The channel to send on. Only SMS exists; anything else is refused. */
  channel?: string;
  to?: string;
  /** SMS only: the body to try. A neutral test sentence by default. */
  text?: string;
  /** SMS only: which event the body stands in for, so the trial mapping matches. */
  kind?: string;
};

const DEFAULT_SMS_TEXT = "Medrella test SMS: this deployment can reach you.";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "doctor") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as SendRequest | null;

  // WhatsApp was a second mobile channel and has been removed. Saying so is
  // better than quietly sending an SMS to someone who asked for WhatsApp.
  if (body?.channel && body.channel !== "sms") {
    return NextResponse.json(
      {
        error:
          'This endpoint sends SMS. WhatsApp is no longer a channel in this app — use {"channel":"sms"}.',
      },
      { status: 400 },
    );
  }

  return sendTestSms(body ?? {});
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
