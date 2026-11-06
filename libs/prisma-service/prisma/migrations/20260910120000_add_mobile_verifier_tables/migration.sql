-- Mobile-verifier tables migrated onto the shared platform DB, prefixed
-- `mobile_verifier_` to identify them as belonging to apps/mobile-verifier
-- (see libs/prisma-service/prisma/schema.prisma). Org identity/permissions are
-- resolved directly against ngotag's own organisation + Keycloak client roles
-- (decoded from the caller's JWT), so mobile-verifier keeps no organization
-- table of its own. Scope: verifier roles, proof templates and mobile-verifier's
-- own webhook registration — verifier users live in the org's registered client
-- system (see mobile_verifier_webhook_config), not this DB; billing was dropped.
--
-- This single migration replaces several incremental ones written while the
-- design was still settling, squashed here since none of the intermediate
-- states were ever deployed anywhere but this branch's local dev DB.

-- CreateTable
CREATE TABLE "mobile_verifier_role" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdByOrgId" TEXT NOT NULL,

    CONSTRAINT "mobile_verifier_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_verifier_proof_template" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT NOT NULL DEFAULT '1',
    "payload" JSONB NOT NULL,
    "createdByOrgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_verifier_proof_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_verifier_role_to_proof_template" (
    "verifierRoleId" TEXT NOT NULL,
    "proofTemplateId" TEXT NOT NULL,

    CONSTRAINT "mobile_verifier_role_to_proof_template_pkey" PRIMARY KEY ("verifierRoleId","proofTemplateId")
);

-- CreateTable
CREATE TABLE "mobile_verifier_webhook_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "webhookUrl" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "authVersion" TEXT NOT NULL,
    "authData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_verifier_webhook_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mobile_verifier_role_orgId_idx" ON "mobile_verifier_role"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "mobile_verifier_proof_template_templateId_key" ON "mobile_verifier_proof_template"("templateId");

-- CreateIndex
CREATE INDEX "mobile_verifier_proof_template_orgId_idx" ON "mobile_verifier_proof_template"("orgId");

-- CreateIndex
CREATE INDEX "mobile_verifier_webhook_config_orgId_idx" ON "mobile_verifier_webhook_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "mobile_verifier_webhook_config_orgId_webhookId_key" ON "mobile_verifier_webhook_config"("orgId", "webhookId");

-- AddForeignKey
ALTER TABLE "mobile_verifier_role_to_proof_template" ADD CONSTRAINT "mobile_verifier_role_to_proof_template_verifierRoleId_fkey" FOREIGN KEY ("verifierRoleId") REFERENCES "mobile_verifier_role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_verifier_role_to_proof_template" ADD CONSTRAINT "mobile_verifier_role_to_proof_template_proofTemplateId_fkey" FOREIGN KEY ("proofTemplateId") REFERENCES "mobile_verifier_proof_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Permission roles gating mobile-verifier writes. The seed only inserts org_roles into an empty
-- table, so a database that was seeded before these existed would never get them and
-- updateUserRoles could not map the Keycloak client roles. Idempotent (name is unique).
INSERT INTO "org_roles" ("id", "name", "description") VALUES
    (gen_random_uuid(), 'ALLOW_PROOF_TEMPLATE', 'Allows creating mobile-verifier proof templates for this organization'),
    (gen_random_uuid(), 'ALLOW_VERIFIER', 'Allows creating mobile-verifier verifier roles for this organization')
ON CONFLICT ("name") DO NOTHING;
