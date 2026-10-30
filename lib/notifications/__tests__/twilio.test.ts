import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTwilioChannel } from "@/lib/notifications/channels/twilio";
import type { NotificationMessage } from "@/lib/notifications/types";

const message: NotificationMessage = {
  to: "+919876543210",
  subject: "",
  text: "Medrella: reminder — appointment with Dr. Rao tomorrow at 10:30.",
};

const TWILIO_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("createTwilioChannel", () => {
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

  it("is not selected without full configuration", () => {
    expect(createTwilioChannel()).toBeNull();

    // A number without credentials is just as unconfigured.
    process.env.TWILIO_FROM = "+14155550123";
    expect(createTwilioChannel()).toBeNull();
  });

  it("sends a form-encoded message and reports the provider sid", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest123";
    process.env.TWILIO_AUTH_TOKEN = "authtoken";
    process.env.TWILIO_FROM = "+14155550123";
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { sid: "SM123" }));

    const channel = createTwilioChannel({ fetchImpl: fetchImpl as unknown as typeof fetch });
    if (!channel) throw new Error("channel should be configured in the test environment");

    const result = await channel.send(message);

    expect(result).toEqual({ providerRef: "SM123" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/Accounts/ACtest123/");
    expect(url).toContain("/Messages.json");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("To=%2B919876543210");
    expect(String(init.body)).toContain("Body=Medrella%3A");
  });

  it("throws on a rejection so the ledger row records the failure", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest123";
    process.env.TWILIO_AUTH_TOKEN = "authtoken";
    process.env.TWILIO_FROM = "+14155550123";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { code: 21211, message: "invalid 'To' number" }));

    const channel = createTwilioChannel({ fetchImpl: fetchImpl as unknown as typeof fetch });
    if (!channel) throw new Error("channel should be configured in the test environment");

    await expect(channel.send(message)).rejects.toThrow("Twilio rejected the SMS (400)");
  });
});
