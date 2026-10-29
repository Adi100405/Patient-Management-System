/**
 * Payment provider contract. Everything the app needs from a gateway lives
 * here, so adding Stripe (or any other provider) means implementing this
 * interface and registering it — no changes to booking, dashboard or refunds.
 */

export type ProviderOrder = {
  id: string;
  /** Amount in the currency's minor unit (paise for INR). */
  amountMinor: number;
  currency: string;
};

export type ProviderPaymentEvent =
  | { type: "captured"; orderId: string; paymentId: string }
  | { type: "failed"; orderId: string; paymentId: string; reason: string }
  | {
      type: "refund.settled";
      refundId: string;
      providerPaymentId: string;
      /** Our refund id, echoed back through the provider's notes field. */
      noteRefundId?: string;
    }
  | {
      type: "refund.failed";
      refundId: string;
      providerPaymentId: string;
      noteRefundId?: string;
      reason: string;
    };

export type ProviderRefund = {
  id: string;
  /** `pending` means the provider accepted it and will settle asynchronously. */
  status: "pending" | "processed" | "failed";
  amountMinor: number;
};

export type CreateRefundInput = {
  providerPaymentId: string;
  amountMinor: number;
  receipt: string;
  notes?: Record<string, string>;
};

export type CreateOrderInput = {
  amountMinor: number;
  currency: string;
  /** Idempotency-friendly reference shown in the provider dashboard. */
  receipt: string;
  notes?: Record<string, string>;
};

export type PaymentProvider = {
  /** Stored on the payment row so historical records stay attributable. */
  readonly name: string;
  createOrder(input: CreateOrderInput): Promise<ProviderOrder>;
  /** Sends money back. The provider settles asynchronously and reports by webhook. */
  createRefund(input: CreateRefundInput): Promise<ProviderRefund>;
  /** Constant-time HMAC check of a webhook body against its signature header. */
  verifyWebhook(rawBody: string, signature: string): boolean;
  /** Normalises a provider payload into the events this app understands. */
  parseWebhookEvent(rawBody: string): ProviderPaymentEvent | null;
  /** Public key the browser checkout needs, if any. */
  publicKeyId(): string | null;
};
