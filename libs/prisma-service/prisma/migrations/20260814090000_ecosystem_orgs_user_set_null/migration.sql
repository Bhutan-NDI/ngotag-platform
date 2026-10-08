/*
  ecosystem_orgs.userId only records who added the org's ecosystem membership row
  (@@unique([orgId, ecosystemId]) is the real identity of this row) -- it is not user-owned data.
  The FK was ON DELETE RESTRICT, so deleteUserAndRelatedData (apps/user/repositories/
  user.repository.ts) had to deleteMany() every ecosystem_orgs row referencing a deleted user just
  to avoid a foreign-key violation on user.delete() -- which silently destroyed the *organisation's*
  ecosystem membership (and any endorsement_transaction rows pointing at it, via its own
  ON DELETE RESTRICT) whenever the user who happened to add it was deleted. See the #71 review.

  marketplace_subscription.localUserId already uses ON DELETE SET NULL for exactly this reason
  (20260512120000_marketplace_billing) -- this migration brings ecosystem_orgs.userId in line with
  that same, already-established pattern instead of inventing a new one.

  No existing row can have userId = NULL yet (the column was NOT NULL until this migration), so
  there's no pre-flight check needed here -- unlike the cloud_wallet_updates migration's unique-
  constraint checks, this alteration cannot fail on existing data.
*/

-- DropForeignKey
ALTER TABLE "ecosystem_orgs" DROP CONSTRAINT "ecosystem_orgs_userId_fkey";

-- AlterTable
ALTER TABLE "ecosystem_orgs" ALTER COLUMN "userId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ecosystem_orgs" ADD CONSTRAINT "ecosystem_orgs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
