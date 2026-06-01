-- Add iso_code and phone_code columns to countries table.
-- These are needed so the API can return ISO2 codes and phone codes
-- alongside numeric IDs (which are now seeded from the country-state-city package).

ALTER TABLE "countries" ADD COLUMN IF NOT EXISTS "iso_code" TEXT NOT NULL DEFAULT '';
ALTER TABLE "countries" ADD COLUMN IF NOT EXISTS "phone_code" TEXT;

-- Add iso_code column to states table.
ALTER TABLE "states" ADD COLUMN IF NOT EXISTS "iso_code" TEXT NOT NULL DEFAULT '';
