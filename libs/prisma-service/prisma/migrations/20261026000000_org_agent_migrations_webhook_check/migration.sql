-- AlterTable
ALTER TABLE "org_agent_migrations" ADD COLUMN     "webhookConfirmedAt" TIMESTAMPTZ(6),
ADD COLUMN     "webhookProbeExpiresAt" TIMESTAMPTZ(6),
ADD COLUMN     "webhookProbeHash" VARCHAR;
