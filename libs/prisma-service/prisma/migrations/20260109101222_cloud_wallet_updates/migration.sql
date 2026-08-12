/*
  Warnings:

  - You are about to alter the column `username` on the `user` table. The data in that column could be lost. The data in that column will be cast from `VarChar(500)` to `VarChar(255)`.
  - A unique constraint covering the columns `[userId]` on the table `cloud_wallet_user_info` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username]` on the table `user` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "user_org_roles" DROP CONSTRAINT "user_org_roles_userId_fkey";

-- DropForeignKey
ALTER TABLE "user_role_mapping" DROP CONSTRAINT "user_role_mapping_userId_fkey";

-- DropIndex
DROP INDEX "cloud_wallet_user_info_email_key";

-- AlterTable
ALTER TABLE "cloud_wallet_user_info" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxSubWallets" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "useCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "username" SET DATA TYPE VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX "cloud_wallet_user_info_userId_key" ON "cloud_wallet_user_info"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_username" ON "user"("username");

-- AddForeignKey
ALTER TABLE "user_org_roles" ADD CONSTRAINT "user_org_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_mapping" ADD CONSTRAINT "user_role_mapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
