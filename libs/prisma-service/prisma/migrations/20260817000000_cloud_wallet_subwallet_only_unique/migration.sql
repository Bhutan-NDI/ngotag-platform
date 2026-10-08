/*
  Scope cloud_wallet_user_info's (email,type) / (userId,type) uniqueness to CLOUD_SUB_WALLET rows
  only, via partial unique indexes — Prisma's schema DSL has no first-class syntax for a
  value-filtered unique constraint, so this is expressed as a raw migration and documented in
  schema.prisma (as @@index, not @@unique) rather than modeled there directly.

  Previously, both compound uniques applied to EVERY row regardless of type, capping a deployment
  at exactly one BASE_WALLET row per admin account ever — directly contradicting this PR's own
  capacity-pool design (getAvailableBaseWallet, getAllBaseWallets -> BaseAgentInfo[], per-wallet
  useCount/maxSubWallets). See the #71 review's "this constraint caps the deployment at one base
  wallet per admin, which makes the capacity-pool this PR builds unreachable".

  This only *narrows* the existing constraints (unique-across-all-rows -> unique-across-a-subset),
  so no pre-flight duplicate check is needed: nothing that was valid before can become invalid.

  Base-wallet uniqueness is not replaced by an equivalent DB constraint: nothing currently
  identifies "the same base wallet" more precisely than agentEndpoint, and agentEndpoint itself is
  not guaranteed unique either (see the #71 review's "findFirst with no orderBy" finding on
  getBaseWalletByAgentEndpoint) — so base-wallet duplicate-prevention stays an application-level
  concern in configureBaseWallet (keyed on agentEndpoint), not a DB-level one, until agentEndpoint
  uniqueness is itself decided.

  SUB_WALLET rows keep exactly the same guarantee as before (at most one per user, at most one per
  email) — only now correctly scoped so it never collides with the BASE_WALLET row the same person
  may also hold.
*/

-- DropIndex
DROP INDEX "cloud_wallet_user_info_email_type_key";
DROP INDEX "cloud_wallet_user_info_userId_type_key";

-- CreateIndex: SUB_WALLET-only partial unique indexes, replacing the two dropped above.
CREATE UNIQUE INDEX "cloud_wallet_user_info_email_type_subwallet_key" ON "cloud_wallet_user_info"("email", "type") WHERE "type" = 'CLOUD_SUB_WALLET';
CREATE UNIQUE INDEX "cloud_wallet_user_info_userId_type_subwallet_key" ON "cloud_wallet_user_info"("userId", "type") WHERE "type" = 'CLOUD_SUB_WALLET';

-- CreateIndex: plain (non-unique) indexes matching the @@index([userId, type])/@@index([email,
-- type]) now declared in schema.prisma, for query-planning parity with the dropped compound
-- uniques (which also served as lookup indexes).
CREATE INDEX "cloud_wallet_user_info_userId_type_idx" ON "cloud_wallet_user_info"("userId", "type");
CREATE INDEX "cloud_wallet_user_info_email_type_idx" ON "cloud_wallet_user_info"("email", "type");
