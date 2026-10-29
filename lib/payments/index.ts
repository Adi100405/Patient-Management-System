import { createRazorpayProvider, manualProvider } from "./razorpay";
import type { PaymentProvider } from "./types";

export type { PaymentProvider, ProviderOrder, ProviderPaymentEvent } from "./types";

/** How long an unpaid online checkout holds an appointment slot. */
export const PAYMENT_HOLD_MINUTES = 15;

/**
 * The gateway that will take money for new bookings. Falls back to `manual`
 * (fee collected at the clinic) when credentials are missing, so a missing key
 * degrades the payment flow rather than breaking bookings.
 */
export function getPaymentProvider(): PaymentProvider {
  return createRazorpayProvider() ?? manualProvider;
}

export function isOnlinePaymentsEnabled(): boolean {
  return getPaymentProvider().name !== manualProvider.name;
}
