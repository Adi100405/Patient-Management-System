import { NextResponse } from "next/server";
import { normalizeContentSid, whatsappStatus } from "@/lib/notifications/channels/twilio";
import {
  WHATSAPP_CONTENT_SID_KEY,
  WHATSAPP_SENDER_KEY,
  loadWhatsappSettings,
  saveWhatsappSetting,
} from "@/lib/notifications/settings";
import { getSession } from "@/lib/session";

/**
 * Read and write the runtime notification configuration.
 *
 * The Twilio credentials stay in the environment; this endpoint only manages
 * the two values an operator may need to change while the clinic is running:
 * the Content Template sid the WhatsApp transport sends with, and the sender
 * it sends from. Both are read by the notification pipeline on the next send,
 * with no redeploy.
 *
 * Doctor-only: changing the transport a clinic's patients are reached on is
 * an operator action, not a patient one.
 */
export const dynamic = "force-dynamic";

type SettingsRequest = {
  /** An `HX…` Content Template sid. Empty string clears the override. */
  contentSid?: string;
  /** An E.164 sender, with or without the `whatsapp:` prefix. */
  sender?: string;
};

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "doctor") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runtime = await loadWhatsappSettings({ force: true });
  const status = whatsappStatus(process.env, runtime);

  return NextResponse.json(
    {
      whatsapp: status,
      runtime: {
        contentSidSet: Boolean(runtime.contentSid),
        contentSidTail: runtime.contentSid ? runtime.contentSid.slice(-4) : null,
        sender: runtime.sender,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "doctor") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as SettingsRequest | null;
  if (!body) {
    return NextResponse.json({ error: "A JSON body is required." }, { status: 400 });
  }

  if (typeof body.contentSid === "string") {
    const trimmed = body.contentSid.trim();
    if (!trimmed) {
      await saveWhatsappSetting(WHATSAPP_CONTENT_SID_KEY, null);
    } else {
      const sid = normalizeContentSid(trimmed);
      if (!sid) {
        return NextResponse.json(
          {
            error:
              "That is not a Content Template sid. It must look like HX followed by 32 hex characters.",
          },
          { status: 400 },
        );
      }
      await saveWhatsappSetting(WHATSAPP_CONTENT_SID_KEY, sid);
    }
  }

  if (typeof body.sender === "string") {
    const trimmed = body.sender.trim().replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "");
    if (!trimmed) {
      await saveWhatsappSetting(WHATSAPP_SENDER_KEY, null);
    } else {
      const sender = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
      if (!/^\+\d{7,15}$/.test(sender)) {
        return NextResponse.json(
          { error: "The sender must be a phone number in E.164 format." },
          { status: 400 },
        );
      }
      await saveWhatsappSetting(WHATSAPP_SENDER_KEY, sender);
    }
  }

  const runtime = await loadWhatsappSettings({ force: true });
  return NextResponse.json(
    {
      ok: true,
      whatsapp: whatsappStatus(process.env, runtime),
      runtime: {
        contentSidSet: Boolean(runtime.contentSid),
        contentSidTail: runtime.contentSid ? runtime.contentSid.slice(-4) : null,
        sender: runtime.sender,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
