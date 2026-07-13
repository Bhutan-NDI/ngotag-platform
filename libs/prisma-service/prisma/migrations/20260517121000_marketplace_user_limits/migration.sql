-- Tighten Marketplace Studio user caps.
UPDATE "marketplace_plan"
SET
    "maxUsers" = CASE "planId"
        WHEN 'starter' THEN 1
        WHEN 'business' THEN 2
        WHEN 'enterprise' THEN 5
        ELSE "maxUsers"
    END,
    "lastChangedDateTime" = CURRENT_TIMESTAMP
WHERE "offerId" = 'phenix-id-platform'
  AND "planId" IN ('starter', 'business', 'enterprise');
