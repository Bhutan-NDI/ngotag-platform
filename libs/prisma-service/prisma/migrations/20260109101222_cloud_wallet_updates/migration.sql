/*
  Warnings:

  - You are about to alter the column `username` on the `user` table. The data in that column could be lost. The data in that column will be cast from `VarChar(500)` to `VarChar(255)`.
  - A unique constraint covering the columns `[userId,type]` on the table `cloud_wallet_user_info` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username]` on the table `user` will be added. If there are existing duplicate values, this will fail.

  Safety: each risky step below is preceded by a pre-flight check that fails loudly with an
  actionable message identifying how many rows are affected, instead of letting Postgres's own
  opaque truncation/unique-violation error abort the migration transaction partway through. See
  the #71 review's "this migration can abort mid-deploy on any environment with existing data" —
  these checks don't eliminate the underlying data risk (that requires an actual cleanup pass
  against each real environment before deploying), they turn a silent mid-migration abort into a
  clear, actionable failure instead.

  cloud_wallet_user_info.email is NOT touched here — it stays @unique (see the #71 review's
  separate "dropping @unique from email breaks every existing cloud-wallet flow at runtime"; the
  DropIndex this migration originally carried has been removed).
*/
-- DropForeignKey
ALTER TABLE "user_org_roles" DROP CONSTRAINT "user_org_roles_userId_fkey";

-- DropForeignKey
ALTER TABLE "user_role_mapping" DROP CONSTRAINT "user_role_mapping_userId_fkey";

-- AlterTable
ALTER TABLE "cloud_wallet_user_info" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxSubWallets" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "useCount" INTEGER NOT NULL DEFAULT 0;

-- Pre-flight: fail loudly instead of silently truncating if any existing username exceeds the
-- new VARCHAR(255) limit.
DO $$
DECLARE
  offending_count integer;
BEGIN
  SELECT count(*) INTO offending_count FROM "user" WHERE length("username") > 255;
  IF offending_count > 0 THEN
    RAISE EXCEPTION 'Cannot narrow user.username to VARCHAR(255): % row(s) exceed 255 characters. Resolve these values before re-running this migration.', offending_count;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "username" SET DATA TYPE VARCHAR(255);

-- Pre-flight: fail loudly instead of a silent unique-violation if any existing (userId, type)
-- pair is already duplicated (e.g. the same admin recorded twice for the same wallet type).
DO $$
DECLARE
  offending_count integer;
BEGIN
  SELECT count(*) INTO offending_count FROM (
    SELECT "userId", "type" FROM "cloud_wallet_user_info"
    WHERE "userId" IS NOT NULL
    GROUP BY "userId", "type"
    HAVING count(*) > 1
  ) duplicates;
  IF offending_count > 0 THEN
    RAISE EXCEPTION 'Cannot add a unique constraint on cloud_wallet_user_info(userId, type): % duplicate pair(s) exist. Resolve these rows before re-running this migration.', offending_count;
  END IF;
END $$;

-- CreateIndex
-- Compound on (userId, type), not a single-column unique on userId — a user may legitimately
-- hold one BASE_WALLET row and one SUB_WALLET row. See the schema's own comment on this model.
CREATE UNIQUE INDEX "cloud_wallet_user_info_userId_type_key" ON "cloud_wallet_user_info"("userId", "type");

-- Pre-flight: fail loudly instead of a silent unique-violation if any existing username is
-- already duplicated (non-null values only — a unique index permits multiple NULLs).
DO $$
DECLARE
  offending_count integer;
BEGIN
  SELECT count(*) INTO offending_count FROM (
    SELECT "username" FROM "user"
    WHERE "username" IS NOT NULL
    GROUP BY "username"
    HAVING count(*) > 1
  ) duplicates;
  IF offending_count > 0 THEN
    RAISE EXCEPTION 'Cannot add a unique constraint on user.username: % duplicate username(s) exist. Resolve these rows before re-running this migration.', offending_count;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "UQ_username" ON "user"("username");

-- AddForeignKey
ALTER TABLE "user_org_roles" ADD CONSTRAINT "user_org_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_mapping" ADD CONSTRAINT "user_role_mapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
