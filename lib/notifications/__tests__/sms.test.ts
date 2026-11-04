import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSmsChannel, smsProvider, smsStatus } from "@/lib/notifications/channels/sms";
import type { FetchLike } from "@/lib/notifications/channels/sms";

/**
 * SMS is one channel with two providers. Vonage wins when both are configured
 * because it is the one that carries the clinic's own text on a free account;
 * Twilio stays as the fallback.
 */

const KEYS = [
  "VONAGE_API_KEY",
  "VONAGE_API_SECRET",
  "VONAGE_FROM",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
] as const;

const TWILIO = {
  TWILIO_ACCOUNT_SID: "ACtest123",
  TWILIO_AUTH_TOKEN: "authtoken",
  TWILIO_FROM: "+17372508034",
};

const VONAGE = {
  VONAGE_API_KEY: "abcd1234",
  VONAGE_API_SECRET: "s3cr3t",
  VONAGE_FROM: "+447700900000",
};

describe("SMS provider selection", () => {
  it("prefers Vonage when both are configured", () => {
    expect(smsProvider({ ...TWILIO, ...VONAGE })).toBe("vonage");
    expect(smsProvider(VONAGE)).toBe("vonage");
    expect(smsProvider(TWILIO)).toBe("twilio");
  });

  it("reports no provider when SMS is not configured at all", () => {
    expect(smsProvider({})).toBeNull();
    // Credentials without a sender are not a setup.
    expect(smsProvider({ TWILIO_ACCOUNT_SID: "ACtest123", TWILIO_AUTH_TOKEN: "authtoken" })).toBeNull();
    expect(smsProvider({ VONAGE_API_KEY: "abcd1234", VONAGE_API_SECRET: "s3cr3t" })).toBeNull();
  });

  it("describes the configuration without echoing the sender", () => {
    expect(smsStatus({ ...TWILIO, ...VONAGE })).toEqual({
      provider: "vonage",
      credentials: true,
      sender: { present: true, tail: "0000" },
      configured: true,
      // Vonage sends the clinic's text as written — nothing is substituted.
      trialFallback: false,
    });

    const twilio = smsStatus(TWILIO);
    expect(twilio.provider).toBe("twilio");
    expect(twilio.sender.tail).toBe("8034");
    // A trial Twilio account may fall back to one of Twilio's templates.
    expect(twilio.trialFallback).toBe(true);
    expect(JSON.stringify(twilio)).not.toContain("173725");
  });
});

describe("SMS transport selection", () => {
  let saved: Array<[string, string | undefined]>;

  beforeEach(() => {
    saved = KEYS.map((key) => [key, process.env[key]] as [string, string | undefined]);
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    }
  });

  it("is the Vonage transport when Vonage is configured", async () => {
    Object.assign(process.env, VONAGE);
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ status: "0", "message-id": "id" }] }), {
        status: 200,
      }),
    );

    const channel = createSmsChannel({ fetchImpl });
    expect(channel?.name).toBe("vonage");

    await channel?.send({
      to: "+919876543210",
      subject: "",
      text: "Medrella: appointment booked.",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://rest.nexmo.com/sms/json");
  });

  it("is the Twilio transport when only Twilio is configured", () => {
    Object.assign(process.env, TWILIO);
    const fetchImpl = vi.fn<FetchLike>();

    const channel = createSmsChannel({ fetchImpl });
    expect(channel?.name).toBe("twilio");
  });

  it("is no transport when neither is configured", () => {
    expect(createSmsChannel()).toBeNull();
  });
});
