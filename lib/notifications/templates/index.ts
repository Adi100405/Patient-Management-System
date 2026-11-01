/**
 * Public entry point for the notification templates. Consumers import from
 * `@/lib/notifications/templates`; the implementations sit alongside this file,
 * split by message family so no single module has to hold every patient-facing
 * sentence at once.
 */
export * from "./shared";
export * from "./appointment";
export * from "./refund";
export * from "./care";
