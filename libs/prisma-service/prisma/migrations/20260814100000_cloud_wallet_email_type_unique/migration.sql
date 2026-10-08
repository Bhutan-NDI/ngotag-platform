/*
  cloud_wallet_user_info.email was still a bare @unique even after the earlier
  20260109101222_cloud_wallet_updates migration replaced the equivalent userId @unique with a
  (userId, type) compound -- for exactly the same reason: the same person's email appears on both
  their BASE_WALLET row (configureBaseWallet) and their own SUB_WALLET row (createCloudWallet), so
  the second row that compound was introduced to allow could never actually be INSERTed; it would
  fail on this constraint regardless of what application code checked first. See the #71 review's
  "the (userId, type) fix is only half applied: email @unique still makes the two-row case
  unreachable".

  A unique constraint covering the columns [email,type] will be added. If there are existing
  duplicate (email, type) pairs, this will fail -- same pre-flight-check discipline as the
  userId/type migration, rather than letting Postgres's own unique-violation abort this migration
  with no actionable message. NULL emails (the username-based signup flow) never collide with
  each other under Postgres's unique-index NULL semantics, so they're excluded from the check.
*/

-- DropIndex
DROP INDEX "cloud_wallet_user_info_email_key";

-- Pre-flight: fail loudly instead of a silent unique-violation if any existing (email, type) pair
-- would collide once the compound index is in place.
DO $$
DECLARE
  offending_count integer;
BEGIN
  SELECT count(*) INTO offending_count FROM (
    SELECT "email", "type" FROM "cloud_wallet_user_info"
    WHERE "email" IS NOT NULL
    GROUP BY "email", "type"
    HAVING count(*) > 1
  ) dupes;
  IF offending_count > 0 THEN
    RAISE EXCEPTION 'Cannot add a unique constraint on cloud_wallet_user_info(email, type): % duplicate pair(s) exist. Resolve these rows before re-running this migration.', offending_count;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "cloud_wallet_user_info_email_type_key" ON "cloud_wallet_user_info"("email", "type");
