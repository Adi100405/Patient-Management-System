import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  createTwilioChannel,
  createTwilioWhatsAppChannel,
} from "@/lib/notifications/channels/twilio";
import type { FetchLike } from "@/lib/notifications/channels/twilio";
import { mobileChannelName } from "@/lib/notifications";
import type { NotificationMessage } from "@/lib/notifications/types";

const message: NotificationMessage = {
  to: "+919876543210",
  subject: "",
  text: "Medrella: reminder — appointment with Dr. Rao tomorrow at 10:30.",
};

/** HX… + 32 hex digits — the shape Twilio issues for Content Templates. */
const CONTENT_SID = "HX" + "0123456789abcdef".repeat(2);
/** The approved template's two placeholders: {{1}} visit date, {{2}} visit time. */
const whatsappVars = { "1": "5 Nov 2026", "2": "10:30" };

const TWILIO_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
  "TWILIO_WHATSAPP_FROM",
  "TWILIO_WHATSAPP_CONTENT_SID",
] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function sentParams(fetchImpl: Mock<FetchLike>, index = 0): URLSearchParams {
  const init = fetchImpl.mock.calls[index]?.[1];
  if (!init) throw new Error("expected the transport to have sent a request");
  return new URLSearchParams(String(init.body));
}

describe("Twilio mobile transports", () => {
  let saved: Array<[string, string | undefined]>;

  beforeEach(() => {
    saved = TWILIO_KEYS.map((key) => [key, process.env[key]] as [string, string | undefined]);
    for (const key of TWILIO_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    }
  });

  describe("SMS", () => {
    it("is not selected without full configuration", () => {
      expect(createTwilioChannel()).toBeNull();

      // A sender without credentials is just as unconfigured.
      process.env.TWILIO_FROM = "+14155550123";
      expect(createTwilioChannel()).toBeNull();
    });

    it("sends a form-encoded message and reports the provider sid", async () => {
      process.env.TWILIO_ACCOUNT_SID = "ACtest123";
      process.env.TWILIO_AUTH_TOKEN = "authtoken";
      process.env.TWILIO_FROM = "+14155550123";
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, { sid: "SM123" }));

      const channel = createTwilioChannel({ fetchImpl });
      if (!channel) throw new Error("channel should be configured in the test environment");

      const result = await channel.send(message);

      expect(result).toEqual({ providerRef: "SM123" });
      const url = fetchImpl.mock.calls[0]?.[0] ?? "";
      expect(url).toContain("/Accounts/ACtest123/");
      expect(url).toContain("/Messages.json");
      expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
      // Plain SMS addresses carry no WhatsApp prefix.
      expect(sentParams(fetchImpl).get("To")).toBe("+919876543210");
      expect(sentParams(fetchImpl).get("From")).toBe("+14155550123");
      expect(sentParams(fetchImpl).get("Body")).toContain("Medrella");
    });

    it("throws on a rejection so the ledger row records the failure", async () => {
      process.env.TWILIO_ACCOUNT_SID = "ACtest123";
      process.env.TWILIO_AUTH_TOKEN = "authtoken";
      process.env.TWILIO_FROM = "+14155550123";
      const fetchImpl = vi
        .fn<FetchLike>()
        .mockResolvedValue(jsonResponse(400, { code: 21211, message: "invalid 'To' number" }));

      const channel = createTwilioChannel({ fetchImpl });
      if (!channel) throw new Error("channel should be configured in the test environment");

      await expect(channel.send(message)).rejects.toThrow("Twilio rejected the SMS (400)");
    });
  });

  describe("WhatsApp", () => {
    /**
     * A transport built with credentials, sender and template sid already set —
     * the exact configuration a deployment needs before WhatsApp is deliverable.
     */
    function whatsappChannel(fetchImpl: Mock<FetchLike>) {
      process.env.TWILIO_ACCOUNT_SID = "ACtest123";
      process.env.TWILIO_AUTH_TOKEN = "authtoken";
      process.env.TWILIO_WHATSAPP_FROM = "+14155238886";
      process.env.TWILIO_WHATSAPP_CONTENT_SID = CONTENT_SID;

      const channel = createTwilioWhatsAppChannel({ fetchImpl });
      if (!channel) throw new Error("channel should be configured in the test environment");
      return channel;
    }

    it("is not selected without a sender AND an approved Content Template", () => {
      expect(createTwilioWhatsAppChannel()).toBeNull();

      process.env.TWILIO_ACCOUNT_SID = "ACtest123";
      process.env.TWILIO_AUTH_TOKEN = "authtoken";
      // Credentials alone must never switch a working SMS setup to WhatsApp.
      expect(createTwilioWhatsAppChannel()).toBeNull();

      process.env.TWILIO_WHATSAPP_FROM = "+14155238886";
      // A sender alone is not a WhatsApp setup either: business-initiated
      // free-form sends are rejected by Twilio outright, so the channel only
      // exists once an approved template is wired up.
      expect(createTwilioWhatsAppChannel()).toBeNull();

      // A malformed sid counts as unconfigured rather than trusted.
      process.env.TWILIO_WHATSAPP_CONTENT_SID = "ACnot-a-template-sid";
      expect(createTwilioWhatsAppChannel()).toBeNull();

      process.env.TWILIO_WHATSAPP_CONTENT_SID = CONTENT_SID;
      expect(createTwilioWhatsAppChannel()).not.toBeNull();
    });

    it("sends the approved template — ContentSid, variables, no Body — over whatsapp:-prefixed addresses", async () => {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, { sid: "SM456" }));

      await whatsappChannel(fetchImpl).send({
        ...message,
        to: "+91 98765 43210",
        contentVariables: whatsappVars,
      });

      const params = sentParams(fetchImpl);
      expect(params.get("To")).toBe("whatsapp:+919876543210");
      expect(params.get("From")).toBe("whatsapp:+14155238886");
      expect(params.get("ContentSid")).toBe(CONTENT_SID);
      expect(JSON.parse(params.get("ContentVariables") ?? "{}")).toEqual(whatsappVars);
      // The plain text exists as the email/SMS fallback — it never rides on
      // WhatsApp, where only the approved template's own body is legitimate.
      expect(params.get("Body")).toBeNull();
    });

    it("refuses a message without template variables instead of shipping free-form text", async () => {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, { sid: "SM456" }));

      await expect(whatsappChannel(fetchImpl).send(message)).rejects.toThrow(
        /Content Template variables/,
      );
      // Twilio is never called for a message the approved template cannot say.
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("names the channel in a rejection so the ledger says which network failed", async () => {
      const fetchImpl = vi
        .fn<FetchLike>()
        .mockResolvedValue(jsonResponse(400, { code: 63016, message: "outside the 24h window" }));

      await expect(
        whatsappChannel(fetchImpl).send({ ...message, contentVariables: whatsappVars }),
      ).rejects.toThrow("Twilio rejected the WhatsApp (400)");
    });
  });
});

describe("mobileChannelName", () => {
  let saved: Array<[string, string | undefined]>;

  beforeEach(() => {
    saved = TWILIO_KEYS.map((key) => [key, process.env[key]] as [string, string | undefined]);
    for (const key of TWILIO_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    }
  });

  it("stays on SMS while WhatsApp has no credentials", () => {
    expect(mobileChannelName()).toBe("sms");
  });

  it("prefers WhatsApp once the sender and its Content Template are configured", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest123";
    process.env.TWILIO_AUTH_TOKEN = "authtoken";
    process.env.TWILIO_FROM = "+14155550123";

    // SMS is configured, but without a WhatsApp sender it stays the choice.
    expect(mobileChannelName()).toBe("sms");

    process.env.TWILIO_WHATSAPP_FROM = "+14155238886";
    // A sender alone is still not a WhatsApp setup: the approved Content
    // Template is what makes a business-initiated send deliverable.
    expect(mobileChannelName()).toBe("sms");

    process.env.TWILIO_WHATSAPP_CONTENT_SID = CONTENT_SID;
    expect(mobileChannelName()).toBe("whatsapp");
  });
});