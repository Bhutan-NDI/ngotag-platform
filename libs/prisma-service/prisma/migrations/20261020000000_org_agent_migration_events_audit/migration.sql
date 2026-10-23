-- AlterTable
ALTER TABLE "org_agent_migration_events" ADD COLUMN "action" VARCHAR(48),
ADD COLUMN "detail" JSONB;
