import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  createTwilioChannel,
  smsTrialTemplate,
} from "@/lib/notifications/channels/twilio";
import type { FetchLike } from "@/lib/notifications/channels/twilio";
import type { NotificationMessage } from "@/lib/notifications/types";

const message: NotificationMessage = {
  to: "+919876543210",
  subject: "",
  text: "Medrella: reminder — appointment with Dr. Rao tomorrow at 10:30.",
};

const TWILIO_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function sentParams(fetchImpl: Mock<FetchLike>, index = 0): URLSearchParams {
  const init = fetchImpl.mock.calls[index]?.[1];
  if (!init) throw new Error("expected the transport to have sent a request");
  return new URLSearchParams(String(init.body));
}

describe("Twilio SMS transport", () => {
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

  /**
   * A trial account cannot send free-form text: Twilio answers `572006`
   * unless `Body` is exactly the name of one of its predefined templates.
   * The transport keeps writing the real message and degrades once — so an
   * upgraded account sends the clinic's words and a trial still delivers.
   */
  describe("on a trial account", () => {
    function smsChannel(fetchImpl: Mock<FetchLike>) {
      process.env.TWILIO_ACCOUNT_SID = "ACtest123";
      process.env.TWILIO_AUTH_TOKEN = "authtoken";
      process.env.TWILIO_FROM = "+14155550123";

      const channel = createTwilioChannel({ fetchImpl });
      if (!channel) throw new Error("channel should be configured in the test environment");
      return channel;
    }

    it("retries a 572006 refusal with the predefined template for the event", async () => {
      const fetchImpl = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(
          jsonResponse(400, {
            code: 572006,
            message: "Trial accounts can only use predefined SMS templates.",
          }),
        )
        .mockResolvedValueOnce(jsonResponse(201, { sid: "SMtrial" }));

      const result = await smsChannel(fetchImpl).send({
        ...message,
        meta: { kind: "payment_confirmed" },
      });

      expect(result).toEqual({
        providerRef: "SMtrial",
        trialTemplate: "sms_order_confirmation",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // The first attempt is the message the clinic actually wrote.
      expect(sentParams(fetchImpl, 0).get("Body")).toContain("Medrella");
      // The retry is Twilio's template *name*, which is the only body a
      // trial account accepts.
      expect(sentParams(fetchImpl, 1).get("Body")).toBe("sms_order_confirmation");
    });

    it("still throws when the retry itself is rejected", async () => {
      const fetchImpl = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(jsonResponse(400, { code: 572006 }))
        .mockResolvedValueOnce(
          jsonResponse(400, { code: 21608, message: "unverified recipient" }),
        );

      await expect(
        smsChannel(fetchImpl).send({ ...message, meta: { kind: "reminder_24h" } }),
      ).rejects.toThrow("Twilio rejected the SMS (400)");
    });

    it("does not retry an ordinary rejection", async () => {
      const fetchImpl = vi
        .fn<FetchLike>()
        .mockResolvedValue(jsonResponse(400, { code: 21608, message: "unverified" }));

      await expect(
        smsChannel(fetchImpl).send({ ...message, meta: { kind: "reminder_24h" } }),
      ).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});

describe("trial SMS templates", () => {
  it("maps each event to the predefined template closest to it", () => {
    expect(smsTrialTemplate("appointment_rescheduled")).toBe("sms_appointment_reminders");
    expect(smsTrialTemplate("reminder_1h")).toBe("sms_appointment_reminders");
    expect(smsTrialTemplate("payment_confirmed")).toBe("sms_order_confirmation");
    expect(smsTrialTemplate("refund_completed")).toBe("sms_customer_support");
    expect(smsTrialTemplate("visit_thanks")).toBe("sms_feedback_surveys");
  });

  it("falls back to the neutral support template for anything unmapped", () => {
    // An event with no close match must still say something harmless rather
    // than borrow appointment wording it cannot honour.
    expect(smsTrialTemplate("generic")).toBe("sms_customer_support");
    expect(smsTrialTemplate(undefined)).toBe("sms_customer_support");
    // `toString` is an own property of no object here — the map is consulted
    // as data, never as a prototype chain.
    expect(smsTrialTemplate("toString")).toBe("sms_customer_support");
  });
});
