import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResendChannel } from "@/lib/notifications/channels/resend";
import type { FetchLike } from "@/lib/notifications/channels/resend";
import type { NotificationMessage } from "@/lib/notifications/types";

const message: NotificationMessage = {
  to: "patient@example.com",
  subject: "Appointment booked",
  text: "Your appointment is booked.",
  html: "<!doctype html><p>Your appointment is booked.</p>",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("createResendChannel", () => {
  const savedKey = process.env.RESEND_API_KEY;

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
  });

  afterEach(() => {
    if (typeof savedKey === "string") process.env.RESEND_API_KEY = savedKey;
    else delete process.env.RESEND_API_KEY;
  });

  it("is not selected without an API key", () => {
    delete process.env.RESEND_API_KEY;
    expect(createResendChannel()).toBeNull();
  });

  it("sends both the html and the plain-text body and reports the message id", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { id: "msg_123" }));

    const channel = createResendChannel({ fetchImpl });
    if (!channel) throw new Error("channel should be configured in the test environment");

    const result = await channel.send(message);

    expect(result).toEqual({ providerRef: "msg_123" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(String(init.body)) as {
      to: string[];
      subject: string;
      text: string;
      html?: string;
    };
    expect(payload.to).toEqual(["patient@example.com"]);
    expect(payload.subject).toBe("Appointment booked");
    expect(payload.text).toBe("Your appointment is booked.");
    expect(payload.html).toBe(message.html);
  });

  it("omits the html field entirely for an SMS-shaped, text-only message", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { id: "msg_456" }));
    const channel = createResendChannel({ fetchImpl });
    if (!channel) throw new Error("channel should be configured in the test environment");

    await channel.send({ to: "patient@example.com", subject: "S", text: "T" });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).not.toContain('"html"');
  });

  it("throws on a rejection so the ledger row records the failure", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(422, { message: "invalid to address" }));

    const channel = createResendChannel({ fetchImpl });
    if (!channel) throw new Error("channel should be configured in the test environment");

    await expect(channel.send(message)).rejects.toThrow("Resend rejected the email (422)");
  });
});
