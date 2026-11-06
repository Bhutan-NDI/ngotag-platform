-- The migration history and its events are the audit trail and must outlive the organisation.
-- DropForeignKey
ALTER TABLE "org_agent_migrations" DROP CONSTRAINT "org_agent_migrations_orgId_fkey";

-- DropForeignKey
ALTER TABLE "org_agent_migration_events" DROP CONSTRAINT "org_agent_migration_events_migrationId_fkey";

-- AddForeignKey
ALTER TABLE "org_agent_migration_events" ADD CONSTRAINT "org_agent_migration_events_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "org_agent_migrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
