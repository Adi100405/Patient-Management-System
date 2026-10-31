import { describe, expect, it, vi } from "vitest";
import { notify, notifyWith } from "@/lib/notifications";
import { dispatchNotification, retryDueNotifications } from "@/lib/notifications/dispatch";
import { MAX_ATTEMPTS, backoffFor } from "@/lib/notifications/retry-policy";
import type {
  NotificationDraft,
  NotificationRecord,
  NotificationStore,
} from "@/lib/notifications/store";
import type { NotificationChannel, NotificationMessage } from "@/lib/notifications/types";

type StoredRow = NotificationRecord & {
  idempotencyKey: string | null;
  providerRef: string | null;
  nextAttemptAt: Date | null;
};

/**
 * In-memory stand-in for the Postgres ledger. It reproduces the behaviour the
 * pipeline relies on: a unique idempotency key, a conditional retry claim and a
 * due-time filter.
 */
class MemoryStore implements NotificationStore {
  readonly rows: StoredRow[] = [];
  private sequence = 0;

  async claim(draft: NotificationDraft): Promise<{ record: NotificationRecord; created: boolean }> {
    if (draft.idempotencyKey !== null) {
      const existing = this.rows.find((row) => row.idempotencyKey === draft.idempotencyKey);
      if (existing) return { record: existing, created: false };
    }

    const row: StoredRow = {
      id: ++this.sequence,
      kind: draft.kind,
      channel: draft.channel,
      recipient: draft.recipient,
      subject: draft.subject,
      body: draft.body,
      htmlBody: draft.htmlBody,
      status: "queued",
      attempts: 1,
      idempotencyKey: draft.idempotencyKey,
      providerRef: null,
      nextAttemptAt: null,
    };
    this.rows.push(row);
    return { record: row, created: true };
  }

  async beginRetry(id: number): Promise<NotificationRecord | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.status !== "failed" || row.attempts >= MAX_ATTEMPTS) return null;
    row.status = "queued";
    row.attempts += 1;
    row.nextAttemptAt = null;
    return row;
  }

  async markSent(id: number, providerRef: string | null): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return;
    row.status = "sent";
    row.nextAttemptAt = null;
    if (providerRef) row.providerRef = providerRef;
  }

  async markFailed(id: number, _error: string, retryAt: Date): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return;
    row.status = "failed";
    row.nextAttemptAt = retryAt;
  }

  async dueRetries(now: Date, limit: number): Promise<NotificationRecord[]> {
    return this.rows
      .filter(
        (row) =>
          row.status === "failed" &&
          row.attempts < MAX_ATTEMPTS &&
          row.nextAttemptAt !== null &&
          row.nextAttemptAt.getTime() <= now.getTime(),
      )
      .slice(0, limit);
  }
}

const message: NotificationMessage = {
  to: "patient@example.com",
  subject: "Appointment booked",
  text: "Your appointment is booked.",
  meta: { kind: "booking_confirmed" },
};

function channel(send: NotificationChannel["send"]): NotificationChannel {
  return { name: "fake", send };
}

const t0 = new Date("2026-10-30T10:00:00.000Z");

describe("dispatchNotification", () => {
  it("sends once and records the provider reference", async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockResolvedValue({ providerRef: "msg_123" });

    const outcome = await dispatchNotification(
      message,
      { kind: "booking_confirmed", channel: "email", idempotencyKey: "booking_confirmed:42" },
      { store, channel: channel(send), now: t0 },
    );

    expect(outcome).toEqual({ delivered: true, id: 1, duplicate: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.rows[0]).toMatchObject({ status: "sent", providerRef: "msg_123", attempts: 1 });
  });

  it("does not send the same idempotency key twice", async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockResolvedValue({});

    const meta = { kind: "booking_confirmed", channel: "email" as const, idempotencyKey: "booking_confirmed:42" };
    await dispatchNotification(message, meta, { store, channel: channel(send), now: t0 });
    const second = await dispatchNotification(message, meta, { store, channel: channel(send), now: t0 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ delivered: true, id: 1, duplicate: true });
  });

  it("records a failure with a backoff and does not rethrow", async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockRejectedValue(new Error("provider down"));

    const outcome = await dispatchNotification(
      message,
      { kind: "booking_confirmed", channel: "email", idempotencyKey: "booking_confirmed:42" },
      { store, channel: channel(send), now: t0 },
    );

    expect(outcome.delivered).toBe(false);
    expect(store.rows[0]?.status).toBe("failed");
    expect(store.rows[0]?.nextAttemptAt?.toISOString()).toBe(
      new Date(t0.getTime() + backoffFor(1)).toISOString(),
    );
  });

  it("does not resend a duplicate event that previously failed", async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockRejectedValue(new Error("provider down"));

    const meta = { kind: "booking_confirmed", channel: "email" as const, idempotencyKey: "booking_confirmed:42" };
    await dispatchNotification(message, meta, { store, channel: channel(send), now: t0 });
    const duplicate = await dispatchNotification(message, meta, { store, channel: channel(send), now: t0 });

    // The retry sweep owns the resend, so a duplicate event cannot cause a burst.
    expect(send).toHaveBeenCalledTimes(1);
    expect(duplicate).toEqual({ delivered: false, id: 1, duplicate: true });
  });
});

describe("retryDueNotifications", () => {
  it("retries a failed row once its backoff has elapsed and marks it sent", async () => {
    const store = new MemoryStore();
    const send = vi
      .fn<NotificationChannel["send"]>()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce({ providerRef: "msg_456" });

    await dispatchNotification(
      message,
      { kind: "booking_confirmed", channel: "email", idempotencyKey: "booking_confirmed:42" },
      { store, channel: channel(send), now: t0 },
    );

    const tooEarly = await retryDueNotifications(
      { store, resolveChannel: () => channel(send), now: new Date(t0.getTime() + 1_000) },
    );
    expect(tooEarly).toEqual({ retried: 0, sent: 0 });

    const later = new Date(t0.getTime() + backoffFor(1) + 1_000);
    const outcome = await retryDueNotifications(
      { store, resolveChannel: () => channel(send), now: later },
    );

    expect(outcome).toEqual({ retried: 1, sent: 1 });
    expect(store.rows[0]).toMatchObject({ status: "sent", attempts: 2, providerRef: "msg_456" });
  });

  it("carries the html body across a retry so a rich email is never downgraded", async () => {
    const store = new MemoryStore();
    const send = vi
      .fn<NotificationChannel["send"]>()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce({});
    const rich: NotificationMessage = {
      ...message,
      html: "<!doctype html><p>Your appointment is booked.</p>",
    };

    await dispatchNotification(
      rich,
      { kind: "booking_confirmed", channel: "email", idempotencyKey: "booking_confirmed:42" },
      { store, channel: channel(send), now: t0 },
    );
    // The ledger keeps the rich body, not only the text fallback.
    expect(store.rows[0]?.htmlBody).toBe(rich.html);

    await retryDueNotifications({
      store,
      resolveChannel: () => channel(send),
      now: new Date(t0.getTime() + backoffFor(1) + 1_000),
    });

    const retried = send.mock.calls.at(1)?.at(0);
    expect(retried?.html).toBe(rich.html);
  });

  it("stops retrying once the attempt cap is reached", async () => {
    const store = new MemoryStore();
    const send = vi.fn<NotificationChannel["send"]>().mockRejectedValue(new Error("down"));

    await dispatchNotification(
      message,
      { kind: "payment_confirmed", channel: "email", idempotencyKey: "payment_confirmed:7" },
      { store, channel: channel(send), now: t0 },
    );

    let now = t0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      now = new Date(now.getTime() + 7 * 60 * 60_000);
      await retryDueNotifications({ store, resolveChannel: () => channel(send), now });
    }

    expect(store.rows[0]?.attempts).toBe(MAX_ATTEMPTS);
    expect(store.rows[0]?.status).toBe("failed");

    const afterCap = await retryDueNotifications({
      store,
      resolveChannel: () => channel(send),
      now: new Date(now.getTime() + 7 * 60 * 60_000),
    });
    expect(afterCap).toEqual({ retried: 0, sent: 0 });
    expect(send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("skips rows whose channel has no transport yet", async () => {
    const store = new MemoryStore();
    const send = vi.fn<NotificationChannel["send"]>().mockRejectedValue(new Error("down"));

    await dispatchNotification(
      { ...message, meta: { kind: "reminder_24h" } },
      { kind: "reminder_24h", channel: "sms", idempotencyKey: "reminder_24h:9" },
      { store, channel: channel(send), now: t0 },
    );

    const outcome = await retryDueNotifications({
      store,
      resolveChannel: (name) => (name === "email" ? channel(send) : null),
      now: new Date(t0.getTime() + 24 * 60 * 60_000),
    });

    expect(outcome).toEqual({ retried: 0, sent: 0 });
    expect(store.rows[0]?.status).toBe("failed");
  });
});

describe("notifyWith", () => {
  it("swallows store failures and reports non-delivery", async () => {
    const brokenStore: NotificationStore = {
      claim: vi.fn().mockRejectedValue(new Error("database down")),
      beginRetry: vi.fn(),
      markSent: vi.fn(),
      markFailed: vi.fn(),
      dueRetries: vi.fn(),
    };
    const send = vi.fn();

    const result = await notifyWith(
      { store: brokenStore, channel: channel(send) },
      message,
      { idempotencyKey: "booking_confirmed:42" },
    );

    expect(result).toEqual({ delivered: false, id: null, duplicate: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("skips the SMS channel cleanly while no SMS provider is configured", async () => {
    // The public entry point resolves transports from the environment, so the
    // test pins the "Twilio unconfigured" state itself.
    const twilioEnv = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"].map((key) => [
      key,
      process.env[key],
    ] as const);
    for (const [key] of twilioEnv) delete process.env[key];

    try {
      const result = await notify(message, { channel: "sms", idempotencyKey: "sms:skip" });
      expect(result).toEqual({ delivered: false, id: null, duplicate: false });
    } finally {
      for (const [key, value] of twilioEnv) {
        if (typeof value === "string") process.env[key] = value;
      }
    }
  });

  it("sends an unkeyed message on every call", async () => {
    const store = new MemoryStore();
    const send = vi.fn<NotificationChannel["send"]>().mockResolvedValue({});

    await notifyWith({ store, channel: channel(send) }, message);
    await notifyWith({ store, channel: channel(send) }, message);

    expect(send).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(2);
  });
});
