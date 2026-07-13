-- Align Marketplace plan metadata with the updated commercial model.
ALTER TABLE "marketplace_plan"
  ADD COLUMN IF NOT EXISTS "baseMonthlyPriceUsd" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "setupFeeUsd" INTEGER NOT NULL DEFAULT 0;

UPDATE "marketplace_plan"
SET
    "displayName" = CASE "planId"
        WHEN 'starter' THEN 'Starter'
        WHEN 'business' THEN 'Business'
        WHEN 'enterprise' THEN 'Enterprise'
        ELSE "displayName"
    END,
    "baseMonthlyPriceUsd" = CASE "planId"
        WHEN 'starter' THEN 550
        WHEN 'business' THEN 2750
        WHEN 'enterprise' THEN 5500
        ELSE "baseMonthlyPriceUsd"
    END,
    "setupFeeUsd" = CASE "planId"
        WHEN 'starter' THEN 30000
        WHEN 'business' THEN 30000
        WHEN 'enterprise' THEN 30000
        ELSE "setupFeeUsd"
    END,
    "includedIssuanceTransactions" = CASE "planId"
        WHEN 'starter' THEN 1000
        WHEN 'business' THEN 5000
        WHEN 'enterprise' THEN 10000
        ELSE "includedIssuanceTransactions"
    END,
    "includedVerificationTransactions" = CASE "planId"
        WHEN 'starter' THEN 1000
        WHEN 'business' THEN 5000
        WHEN 'enterprise' THEN 10000
        ELSE "includedVerificationTransactions"
    END,
    "includedSchemas" = CASE "planId"
        WHEN 'starter' THEN 1
        WHEN 'business' THEN 5
        WHEN 'enterprise' THEN 10
        ELSE "includedSchemas"
    END,
    "maxOrganizations" = CASE "planId"
        WHEN 'starter' THEN 1
        WHEN 'business' THEN 1
        WHEN 'enterprise' THEN 5
        ELSE "maxOrganizations"
    END,
    "maxUsers" = CASE "planId"
        WHEN 'starter' THEN 1
        WHEN 'business' THEN 2
        WHEN 'enterprise' THEN 5
        ELSE "maxUsers"
    END,
    "lastChangedDateTime" = CURRENT_TIMESTAMP
WHERE "offerId" = 'phenix-id-platform'
  AND "planId" IN ('starter', 'business', 'enterprise');
