-- CreateTable
CREATE TABLE "org_agent_migrations" (
    "id" UUID NOT NULL,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orgId" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'CREATED',
    "phase" VARCHAR(32),
    "startedBy" UUID NOT NULL,
    "sourceOrgAgentSnapshot" JSONB,
    "tenantId" TEXT,
    "targetAdminEndpoint" VARCHAR,
    "targetDidcommEndpoint" VARCHAR,
    "newInvitationDid" VARCHAR,
    "legacyInvitationDid" VARCHAR,
    "exportJobId" VARCHAR,
    "importJobId" VARCHAR,
    "rotationJobId" VARCHAR,
    "counts" JSONB,
    "checksum" VARCHAR,
    "importKeyFingerprint" VARCHAR,
    "releaseVersion" VARCHAR,
    "storageVersion" VARCHAR,
    "rehearsalDurationMs" INTEGER,
    "predictedFreezeMs" INTEGER,
    "freezeDeadline" TIMESTAMPTZ(6),
    "stabilisationEndsAt" TIMESTAMPTZ(6),
    "purgedAt" TIMESTAMPTZ(6),
    "error" VARCHAR,

    CONSTRAINT "org_agent_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_agent_migration_events" (
    "id" UUID NOT NULL,
    "createDateTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "migrationId" UUID NOT NULL,
    "fromStatus" VARCHAR(32),
    "toStatus" VARCHAR(32) NOT NULL,
    "actor" VARCHAR,

    CONSTRAINT "org_agent_migration_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_agent_migrations_orgId_idx" ON "org_agent_migrations"("orgId");

-- CreateIndex
CREATE INDEX "org_agent_migrations_status_idx" ON "org_agent_migrations"("status");

-- CreateIndex
CREATE INDEX "org_agent_migration_events_migrationId_idx" ON "org_agent_migration_events"("migrationId");

-- AddForeignKey
ALTER TABLE "org_agent_migrations" ADD CONSTRAINT "org_agent_migrations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_agent_migration_events" ADD CONSTRAINT "org_agent_migration_events_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "org_agent_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one non-terminal migration per org. Prisma's schema DSL cannot express a partial unique
-- index, so it lives here (same approach as org_dids_one_primary_per_org_unique).
CREATE UNIQUE INDEX "org_agent_migrations_one_active_per_org_unique"
    ON "org_agent_migrations" ("orgId")
    WHERE "status" NOT IN ('COMPLETED', 'FAILED', 'DISASTER_RESTORED');
