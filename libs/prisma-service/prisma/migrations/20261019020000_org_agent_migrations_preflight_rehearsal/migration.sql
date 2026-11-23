-- AlterTable
ALTER TABLE "org_agent_migrations" ADD COLUMN "targetTokenEncrypted" VARCHAR,
ADD COLUMN "backupsConfirmedAt" TIMESTAMPTZ(6),
ADD COLUMN "preflight" JSONB,
ADD COLUMN "rehearsalStatus" VARCHAR(16),
ADD COLUMN "rehearsalStartedAt" TIMESTAMPTZ(6),
ADD COLUMN "rehearsal" JSONB;
