-- Drop FK constraints from organisation to geo tables.
-- Geo data is now served from the country-state-city npm package (in-memory),
-- so countryId / stateId / cityId on organisation are plain integer identifiers,
-- not DB foreign keys. Referential integrity is no longer meaningful here.

ALTER TABLE "organisation" DROP CONSTRAINT IF EXISTS "organisation_countryId_fkey";
ALTER TABLE "organisation" DROP CONSTRAINT IF EXISTS "organisation_stateId_fkey";
ALTER TABLE "organisation" DROP CONSTRAINT IF EXISTS "organisation_cityId_fkey";
