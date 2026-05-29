-- Remove cloud-wallet tenant limits and metering from Marketplace billing.
ALTER TABLE "marketplace_plan" DROP COLUMN IF EXISTS "includedWalletTenants";
ALTER TABLE "marketplace_plan" DROP COLUMN IF EXISTS "maxWalletTenants";

UPDATE "marketplace_plan"
SET
    "features" = "features" - 'cloudWallet',
    "lastChangedDateTime" = CURRENT_TIMESTAMP
WHERE "offerId" = 'phenix-id-platform';

UPDATE "marketplace_usage_event"
SET
    "status" = 'expired',
    "marketplaceMessage" = 'wallet_tenant Marketplace billing dimension removed',
    "lastChangedDateTime" = CURRENT_TIMESTAMP
WHERE "dimension" = 'wallet_tenant'
  AND "status" IN ('pending', 'failed');
