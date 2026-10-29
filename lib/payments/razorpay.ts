import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreateOrderInput,
  CreateRefundInput,
  PaymentProvider,
  ProviderOrder,
  ProviderPaymentEvent,
  ProviderRefund,
} from "./types";

const ORDERS_URL = "https://api.razorpay.com/v1/orders";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Razorpay implementation of the payment provider contract.
 *
 * Orders are created server-side so the amount always comes from the doctor's
 * fee in our database — the browser never states what it is willing to pay.
 */
class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay";

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<ProviderOrder> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
    const response = await fetch(ORDERS_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes ?? {},
      }),
    });

    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload)) {
      throw new Error("The payment gateway rejected the order. Please try again.");
    }

    const id = readString(payload, "id");
    if (!id) {
      throw new Error("The payment gateway returned an unusable order.");
    }

    return {
      id,
      amountMinor: readNumber(payload, "amount") ?? input.amountMinor,
      currency: readString(payload, "currency") ?? input.currency,
    };
  }

  /**
   * Issues a refund against a captured payment. Razorpay accepts it and settles
   * asynchronously, so the returned `pending` status is expected; the
   * `refund.processed` webhook is what completes it in our ledger.
   */
  async createRefund(input: CreateRefundInput): Promise<ProviderRefund> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
    const response = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: input.amountMinor,
          receipt: input.receipt,
          notes: input.notes ?? {},
        }),
      },
    );

    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload)) {
      throw new Error("The payment gateway rejected the refund request.");
    }

    const id = readString(payload, "id");
    if (!id) throw new Error("The payment gateway returned an unusable refund.");

    const status = readString(payload, "status");
    return {
      id,
      status: status === "processed" ? "processed" : status === "failed" ? "failed" : "pending",
      amountMinor: readNumber(payload, "amount") ?? input.amountMinor,
    };
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    if (!signature || !this.webhookSecret) return false;
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const expectedBuffer = Buffer.from(expected, "utf8");
    const signatureBuffer = Buffer.from(signature, "utf8");
    if (expectedBuffer.length !== signatureBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, signatureBuffer);
  }

  parseWebhookEvent(rawBody: string): ProviderPaymentEvent | null {
    const parsed: unknown = JSON.parse(rawBody);
    if (!isRecord(parsed)) return null;

    const event = readString(parsed, "event");
    const payload = parsed.payload;
    if (!isRecord(payload)) return null;

    if (event === "refund.processed" || event === "refund.failed") {
      const refund = payload.refund;
      if (!isRecord(refund)) return null;
      const entity = refund.entity;
      if (!isRecord(entity)) return null;

      const refundId = readString(entity, "id");
      const providerPaymentId = readString(entity, "payment_id");
      if (!refundId || !providerPaymentId) return null;

      // We put our refund id in the provider's notes; it comes back on the
      // webhook, which lets us match a settlement that races our own write.
      const notes = entity.notes;
      const noteRefundId = isRecord(notes) ? (readString(notes, "refundId") ?? undefined) : undefined;

      return event === "refund.processed"
        ? { type: "refund.settled", refundId, providerPaymentId, noteRefundId }
        : {
            type: "refund.failed",
            refundId,
            providerPaymentId,
            noteRefundId,
            reason: readString(entity, "status") ?? "refund_failed",
          };
    }

    const payment = payload.payment;
    if (!isRecord(payment)) return null;

    const entity = payment.entity;
    if (!isRecord(entity)) return null;

    const orderId = readString(entity, "order_id");
    const paymentId = readString(entity, "id");
    if (!orderId || !paymentId) return null;

    if (event === "payment.captured") {
      return { type: "captured", orderId, paymentId };
    }
    if (event === "payment.failed") {
      return {
        type: "failed",
        orderId,
        paymentId,
        reason: readString(entity, "error_description") ?? readString(entity, "status") ?? "payment_failed",
      };
    }
    return null;
  }

  publicKeyId(): string | null {
    return this.keyId;
  }
}

/** Returns a configured Razorpay provider, or null when keys are absent. */
export function createRazorpayProvider(): PaymentProvider | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!keyId || !keySecret || !webhookSecret) return null;
  return new RazorpayProvider(keyId, keySecret, webhookSecret);
}

/**
 * A gateway that cannot take money: used when no provider is configured, so the
 * app keeps working end-to-end with fees collected at the clinic instead of
 * failing booking for everyone.
 */
export const manualProvider: PaymentProvider = {
  name: "manual",
  async createOrder(): Promise<ProviderOrder> {
    throw new Error("Online payments are not configured.");
  },
  async createRefund(): Promise<ProviderRefund> {
    throw new Error("Online refunds are not configured.");
  },
  verifyWebhook(): boolean {
    return false;
  },
  parseWebhookEvent(): ProviderPaymentEvent | null {
    return null;
  },
  publicKeyId(): string | null {
    return null;
  },
};
