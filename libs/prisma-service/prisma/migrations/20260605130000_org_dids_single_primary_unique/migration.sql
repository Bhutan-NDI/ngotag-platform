-- Enforce at most one primary DID per organization.
--
-- The primary-DID assignment in AgentServiceRepository.persistDidWithUpdates is read-then-write:
-- the transaction demotes the org's other DIDs (updateMany isPrimaryDid = false) and then marks the
-- new/existing DID primary. Two concurrent primary creations can each run that demotion before the
-- other's primary row is visible, then both commit isPrimaryDid = true, leaving an org with multiple
-- primary DIDs. This partial unique index is the atomic backstop - the second concurrent commit
-- fails with a unique violation (P2002), which surfaces as an error the caller can retry.
--
-- Only primary rows occupy the index, so an org can still hold many non-primary DIDs and can freely
-- swap which one is primary (the demotion + promotion happen in the same transaction).
--
-- NOTE: this filtered unique index cannot be expressed in schema.prisma and is kept as a manual
-- migration. The UPDATE below first reconciles any pre-existing duplicate primaries (possible from
-- the earlier non-atomic writes / per-DID updateMany loop) by keeping the most recently created
-- primary per org and demoting the rest, so the CREATE INDEX cannot fail on legacy data.
UPDATE "org_dids" o
SET "isPrimaryDid" = false
WHERE "isPrimaryDid"
  AND "id" <> (
    SELECT p."id"
    FROM "org_dids" p
    WHERE p."orgId" = o."orgId"
      AND p."isPrimaryDid"
    ORDER BY p."createDateTime" DESC, p."id" DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX "org_dids_one_primary_per_org_unique"
    ON "org_dids" ("orgId")
    WHERE "isPrimaryDid";
