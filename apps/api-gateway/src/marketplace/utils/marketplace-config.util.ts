/**
 * Single source of truth for the marketplace feature flags, so call sites don't re-implement
 * `process.env.*` string checks inline (which is how MARKETPLACE_METERING_ENABLED ended up defined
 * but never honored). Both flags default to OFF unless explicitly set to the string 'true'.
 */
const isFlagEnabled = (value: string | undefined): boolean => 'true' === `${value}`.toLowerCase();

/** Master switch for the whole marketplace/billing feature. */
export const isMarketplaceEnabled = (): boolean => isFlagEnabled(process.env.MARKETPLACE_ENABLED);

/**
 * Usage metering is a sub-feature of the marketplace: it only runs when the marketplace is enabled
 * AND metering is explicitly enabled. When either is off, issuance/verification must not attempt to
 * record usage (no marketplace microservice to receive it → noisy warnings for nothing).
 */
export const isMarketplaceMeteringEnabled = (): boolean => isMarketplaceEnabled() && isFlagEnabled(process.env.MARKETPLACE_METERING_ENABLED);
