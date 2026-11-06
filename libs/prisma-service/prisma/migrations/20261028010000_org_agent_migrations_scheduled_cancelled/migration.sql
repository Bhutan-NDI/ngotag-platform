-- The status alone says where a move is; a cancelled move is terminal like the others.
ALTER TABLE "org_agent_migrations" DROP COLUMN "phase";

DROP INDEX "org_agent_migrations_one_active_per_org_unique";

CREATE UNIQUE INDEX "org_agent_migrations_one_active_per_org_unique"
    ON "org_agent_migrations" ("orgId")
    WHERE "status" NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'DISASTER_RESTORED');
