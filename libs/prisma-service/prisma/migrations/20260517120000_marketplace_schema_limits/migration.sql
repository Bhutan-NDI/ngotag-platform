-- Tighten Marketplace schema creation caps to reduce ledger/schema costs.
UPDATE "marketplace_plan"
SET
    "includedSchemas" = CASE "planId"
        WHEN 'starter' THEN 1
        WHEN 'business' THEN 5
        WHEN 'enterprise' THEN 10
        ELSE "includedSchemas"
    END,
    "lastChangedDateTime" = CURRENT_TIMESTAMP
WHERE "offerId" = 'phenix-id-platform'
  AND "planId" IN ('starter', 'business', 'enterprise');
