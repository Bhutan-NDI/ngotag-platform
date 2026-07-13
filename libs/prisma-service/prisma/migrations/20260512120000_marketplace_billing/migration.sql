-- CreateEnum
CREATE TYPE "MarketplaceSubscriptionStatus" AS ENUM ('PendingFulfillmentStart', 'Subscribed', 'Suspended', 'Unsubscribed');

-- CreateEnum
CREATE TYPE "MarketplaceActivationStatus" AS ENUM ('not_started', 'in_progress', 'activated', 'failed');

-- CreateEnum
CREATE TYPE "MarketplaceOnboardingStatus" AS ENUM ('resolved', 'account_linked', 'org_linked', 'activation_pending', 'activated', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "MarketplaceUsageStatus" AS ENUM ('pending', 'submitted', 'accepted', 'duplicate', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "MarketplaceWebhookProcessingStatus" AS ENUM ('received', 'validated', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "MarketplaceOperationAckStatus" AS ENUM ('not_required', 'pending', 'success', 'failure');

-- CreateTable
CREATE TABLE "marketplace_subscription" (
    "id" UUID NOT NULL,
    "marketplaceSubscriptionId" TEXT NOT NULL,
    "publisherId" TEXT,
    "offerId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "subscriptionName" TEXT,
    "saasSubscriptionStatus" "MarketplaceSubscriptionStatus" NOT NULL DEFAULT 'PendingFulfillmentStart',
    "quantity" INTEGER,
    "termUnit" TEXT,
    "termStartDate" TIMESTAMPTZ(6),
    "termEndDate" TIMESTAMPTZ(6),
    "autoRenew" BOOLEAN,
    "isFreeTrial" BOOLEAN,
    "isTest" BOOLEAN,
    "sandboxType" TEXT,
    "allowedCustomerOperations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "purchaserEmail" TEXT,
    "purchaserTenantId" TEXT,
    "purchaserObjectId" TEXT,
    "purchaserPuid" TEXT,
    "beneficiaryEmail" TEXT,
    "beneficiaryTenantId" TEXT,
    "beneficiaryObjectId" TEXT,
    "beneficiaryPuid" TEXT,
    "localUserId" UUID,
    "orgId" UUID,
    "activationStatus" "MarketplaceActivationStatus" NOT NULL DEFAULT 'not_started',
    "activationError" TEXT,
    "lastResolvedAt" TIMESTAMPTZ(6),
    "lastSyncedAt" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(6),

    CONSTRAINT "marketplace_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_onboarding_session" (
    "id" UUID NOT NULL,
    "marketplaceSubscriptionId" UUID NOT NULL,
    "marketplaceTokenHash" TEXT NOT NULL,
    "buyerTenantId" TEXT,
    "buyerObjectId" TEXT,
    "buyerEmail" TEXT,
    "status" "MarketplaceOnboardingStatus" NOT NULL DEFAULT 'resolved',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "metadata" JSONB,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_onboarding_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_plan" (
    "id" UUID NOT NULL,
    "offerId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "baseMonthlyPriceUsd" INTEGER NOT NULL DEFAULT 0,
    "setupFeeUsd" INTEGER NOT NULL DEFAULT 0,
    "includedIssuanceTransactions" INTEGER NOT NULL DEFAULT 0,
    "includedVerificationTransactions" INTEGER NOT NULL DEFAULT 0,
    "includedSchemas" INTEGER NOT NULL DEFAULT 0,
    "maxOrganizations" INTEGER,
    "maxUsers" INTEGER,
    "features" JSONB NOT NULL,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_usage_event" (
    "id" UUID NOT NULL,
    "marketplaceSubscriptionId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "usageStartTime" TIMESTAMPTZ(6) NOT NULL,
    "status" "MarketplaceUsageStatus" NOT NULL DEFAULT 'pending',
    "marketplaceResponseStatus" TEXT,
    "marketplaceMessage" TEXT,
    "requestId" TEXT,
    "correlationId" TEXT,
    "submittedAt" TIMESTAMPTZ(6),
    "sourceEventIds" JSONB,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_usage_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_usage_event" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "marketplaceSubscriptionId" UUID,
    "eventType" TEXT NOT NULL,
    "sourceTable" TEXT,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "billingPeriod" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_usage_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_webhook_event" (
    "id" UUID NOT NULL,
    "operationId" TEXT,
    "activityId" TEXT,
    "subscriptionId" TEXT NOT NULL,
    "marketplaceSubscriptionId" UUID,
    "action" TEXT NOT NULL,
    "status" TEXT,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "validationStatus" TEXT,
    "processingStatus" "MarketplaceWebhookProcessingStatus" NOT NULL DEFAULT 'received',
    "error" TEXT,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_operation" (
    "id" UUID NOT NULL,
    "operationId" TEXT NOT NULL,
    "marketplaceSubscriptionId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT,
    "planId" TEXT,
    "quantity" INTEGER,
    "rawPayload" JSONB,
    "ackStatus" "MarketplaceOperationAckStatus" NOT NULL DEFAULT 'pending',
    "ackError" TEXT,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_operation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_subscription_marketplaceSubscriptionId_key" ON "marketplace_subscription"("marketplaceSubscriptionId");
CREATE INDEX "marketplace_subscription_orgId_idx" ON "marketplace_subscription"("orgId");
CREATE INDEX "marketplace_subscription_localUserId_idx" ON "marketplace_subscription"("localUserId");
CREATE INDEX "marketplace_subscription_saasSubscriptionStatus_idx" ON "marketplace_subscription"("saasSubscriptionStatus");

-- CreateIndex
CREATE INDEX "marketplace_onboarding_session_expiresAt_idx" ON "marketplace_onboarding_session"("expiresAt");
CREATE INDEX "marketplace_onboarding_session_marketplaceSubscriptionId_idx" ON "marketplace_onboarding_session"("marketplaceSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_plan_offerId_planId_key" ON "marketplace_plan"("offerId", "planId");
CREATE INDEX "marketplace_plan_isActive_idx" ON "marketplace_plan"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_usage_event_marketplaceSubscriptionId_dimension_usageStartTime_key" ON "marketplace_usage_event"("marketplaceSubscriptionId", "dimension", "usageStartTime");
CREATE INDEX "marketplace_usage_event_status_usageStartTime_idx" ON "marketplace_usage_event"("status", "usageStartTime");
CREATE INDEX "marketplace_usage_event_orgId_idx" ON "marketplace_usage_event"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_usage_event_eventType_sourceId_key" ON "billing_usage_event"("eventType", "sourceId");
CREATE INDEX "billing_usage_event_orgId_occurredAt_idx" ON "billing_usage_event"("orgId", "occurredAt");
CREATE INDEX "billing_usage_event_marketplaceSubscriptionId_idx" ON "billing_usage_event"("marketplaceSubscriptionId");

-- CreateIndex
CREATE INDEX "marketplace_webhook_event_operationId_idx" ON "marketplace_webhook_event"("operationId");
CREATE INDEX "marketplace_webhook_event_subscriptionId_idx" ON "marketplace_webhook_event"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_operation_operationId_marketplaceSubscriptionId_key" ON "marketplace_operation"("operationId", "marketplaceSubscriptionId");
CREATE INDEX "marketplace_operation_action_idx" ON "marketplace_operation"("action");

-- AddForeignKey
ALTER TABLE "marketplace_subscription" ADD CONSTRAINT "marketplace_subscription_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_subscription" ADD CONSTRAINT "marketplace_subscription_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_onboarding_session" ADD CONSTRAINT "marketplace_onboarding_session_marketplaceSubscriptionId_fkey" FOREIGN KEY ("marketplaceSubscriptionId") REFERENCES "marketplace_subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketplace_usage_event" ADD CONSTRAINT "marketplace_usage_event_marketplaceSubscriptionId_fkey" FOREIGN KEY ("marketplaceSubscriptionId") REFERENCES "marketplace_subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketplace_usage_event" ADD CONSTRAINT "marketplace_usage_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_usage_event" ADD CONSTRAINT "billing_usage_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_usage_event" ADD CONSTRAINT "billing_usage_event_marketplaceSubscriptionId_fkey" FOREIGN KEY ("marketplaceSubscriptionId") REFERENCES "marketplace_subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_webhook_event" ADD CONSTRAINT "marketplace_webhook_event_marketplaceSubscriptionId_fkey" FOREIGN KEY ("marketplaceSubscriptionId") REFERENCES "marketplace_subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_operation" ADD CONSTRAINT "marketplace_operation_marketplaceSubscriptionId_fkey" FOREIGN KEY ("marketplaceSubscriptionId") REFERENCES "marketplace_subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed initial Marketplace plan metadata used by entitlement and metering calculations.
INSERT INTO "marketplace_plan" (
    "id",
    "offerId",
    "planId",
    "displayName",
    "baseMonthlyPriceUsd",
    "setupFeeUsd",
    "includedIssuanceTransactions",
    "includedVerificationTransactions",
    "includedSchemas",
    "maxOrganizations",
    "maxUsers",
    "features"
) VALUES
    ('00000000-0000-0000-0000-000000000101', 'phenix-id-platform', 'starter', 'Starter', 550, 30000, 1000, 1000, 1, 1, 1, '{"schemaCreate":true,"credentialDefinitionCreate":true,"issuance":true,"bulkIssuance":true,"verification":true,"apiAccess":true}'::jsonb),
    ('00000000-0000-0000-0000-000000000102', 'phenix-id-platform', 'business', 'Business', 2750, 30000, 5000, 5000, 5, 1, 2, '{"schemaCreate":true,"credentialDefinitionCreate":true,"issuance":true,"bulkIssuance":true,"verification":true,"apiAccess":true}'::jsonb),
    ('00000000-0000-0000-0000-000000000103', 'phenix-id-platform', 'enterprise', 'Enterprise', 5500, 30000, 10000, 10000, 10, 5, 5, '{"schemaCreate":true,"credentialDefinitionCreate":true,"issuance":true,"bulkIssuance":true,"verification":true,"apiAccess":true}'::jsonb);
