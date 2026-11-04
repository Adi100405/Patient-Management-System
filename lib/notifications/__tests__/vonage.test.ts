import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  createVonageChannel,
  normalizeSender,
  vonageConfig,
  vonageStatus,
} from "@/lib/notifications/channels/vonage";
import type { FetchLike } from "@/lib/notifications/channels/vonage";
import type { NotificationMessage } from "@/lib/notifications/types";

/**
 * The Vonage transport carries the clinic's own text — even on a trial
 * account — which is the whole reason it exists next to Twilio.
 */

const message: NotificationMessage = {
  to: "+91 98765 43210",
  subject: "",
  text: "Medrella: payment of ₹500 received. Your appointment is confirmed.",
};

const VONAGE_KEYS = ["VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_FROM"] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function sentParams(fetchImpl: Mock<FetchLike>, index = 0): URLSearchParams {
  const init = fetchImpl.mock.calls[index]?.[1];
  if (!init) throw new Error("expected the transport to have sent a request");
  return new URLSearchParams(String(init.body));
}

describe("Vonage SMS transport", () => {
  let saved: Array<[string, string | undefined]>;

  beforeEach(() => {
    saved = VONAGE_KEYS.map((key) => [key, process.env[key]] as [string, string | undefined]);
    for (const key of VONAGE_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    }
  });

  function configure() {
    process.env.VONAGE_API_KEY = "abcd1234";
    process.env.VONAGE_API_SECRET = "s3cr3t";
    process.env.VONAGE_FROM = "+447700900000";
  }

  it("is not selected without an API key, a secret and a sender", () => {
    expect(createVonageChannel()).toBeNull();

    process.env.VONAGE_API_KEY = "abcd1234";
    process.env.VONAGE_API_SECRET = "s3cr3t";
    // No sender: nothing can go out.
    expect(createVonageChannel()).toBeNull();

    process.env.VONAGE_FROM = "Medrella";
    expect(createVonageChannel()).not.toBeNull();
  });

  it("posts the clinic's own text to Vonage's SMS endpoint", async () => {
    configure();
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(200, {
        "message-count": "1",
        messages: [{ status: "0", "message-id": "0A0000001234567B" }],
      }),
    );

    const channel = createVonageChannel({ fetchImpl });
    if (!channel) throw new Error("channel should be configured in the test environment");

    const result = await channel.send(message);

    expect(result).toEqual({ providerRef: "0A0000001234567B" });
    const url = fetchImpl.mock.calls[0]?.[0] ?? "";
    expect(url).toBe("https://rest.nexmo.com/sms/json");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");

    const params = sentParams(fetchImpl);
    expect(params.get("api_key")).toBe("abcd1234");
    expect(params.get("api_secret")).toBe("s3cr3t");
    // Numbers go out as bare digits, without the leading plus.
    expect(params.get("from")).toBe("447700900000");
    expect(params.get("to")).toBe("919876543210");
    // The text is the clinic's, untouched — the whole point of this provider.
    expect(params.get("text")).toBe(message.text);
    // The rupee sign means this cannot be sent as plain GSM.
    expect(params.get("type")).toBe("unicode");
  });

  it("sends ASCII text as plain GSM", async () => {
    configure();
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(200, { messages: [{ status: "0", "message-id": "id" }] }),
    );

    const channel = createVonageChannel({ fetchImpl });
    if (!channel) throw new Error("channel should be configured in the test environment");

    await channel.send({ ...message, text: "Medrella: appointment booked." });

    expect(sentParams(fetchImpl).get("type")).toBe("text");
  });

  it("throws when Vonage refuses the message in a 200 response", async () => {
    configure();
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(200, {
        "message-count": "1",
        messages: [{ status: "29", "error-text": "Non-whitelisted destination" }],
      }),
    );

    const channel = createVonageChannel({ fetchImpl });
    if (!channel) throw new Error("channel should be configured in the test environment");

    await expect(channel.send(message)).rejects.toThrow(
      "Vonage rejected the SMS (29): Non-whitelisted destination",
    );
  });

  it("throws when the credentials are wrong", async () => {
    configure();
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(200, {
        "error-code": "401",
        "error-code-label": "authentication failed",
      }),
    );

    const channel = createVonageChannel({ fetchImpl });
    if (!channel) throw new Error("channel should be configured in the test environment");

    await expect(channel.send(message)).rejects.toThrow("Vonage rejected the SMS (401)");
  });

  it("throws when the request itself fails", async () => {
    configure();
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(500, "upstream down"));

    const channel = createVonageChannel({ fetchImpl });
    if (!channel) throw new Error("channel should be configured in the test environment");

    await expect(channel.send(message)).rejects.toThrow("Vonage rejected the SMS (500)");
  });
});

describe("Vonage configuration", () => {
  it("keeps a numeric sender as digits and a sender ID as itself", () => {
    expect(normalizeSender("+44 7700 900000")).toBe("447700900000");
    expect(normalizeSender("(478) 607-6444")).toBe("4786076444");
    expect(normalizeSender("Medrella")).toBe("Medrella");
  });

  it("is only configured when the key, the secret and the sender are all there", () => {
    expect(vonageConfig({})).toBeNull();
    expect(vonageConfig({ VONAGE_API_KEY: "abcd1234", VONAGE_API_SECRET: "s3cr3t" })).toBeNull();

    expect(
      vonageConfig({
        VONAGE_API_KEY: "abcd1234",
        VONAGE_API_SECRET: "s3cr3t",
        VONAGE_FROM: "+447700900000",
      }),
    ).toEqual({ apiKey: "abcd1234", apiSecret: "s3cr3t", from: "447700900000" });
  });

  it("reports the sender without echoing it", () => {
    expect(vonageStatus({})).toEqual({
      credentials: false,
      sender: { present: false, tail: null },
      configured: false,
    });

    const ready = vonageStatus({
      VONAGE_API_KEY: "abcd1234",
      VONAGE_API_SECRET: "s3cr3t",
      VONAGE_FROM: "+447700900000",
    });
    expect(ready.configured).toBe(true);
    expect(ready.sender.tail).toBe("0000");
    expect(JSON.stringify(ready)).not.toContain("7700");
  });
});
