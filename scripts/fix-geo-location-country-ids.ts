/* eslint-disable camelcase */
/* eslint-disable no-console */
// One-off corrective data fix for environments seeded before commit a04f80ed
// ("fix: replace broken geo CSV data with country-state-city npm package seed").
//
// The legacy `geo-location-master-data/states.csv` / `cities.csv` files had their
// `country_id` column shifted relative to `country_code` for the large majority of
// rows (e.g. Bosnia and Herzegovina's cantons were stored under Bhutan's country id).
// `seedGeoLocationData` in `libs/prisma-service/prisma/seed.ts` only seeds a database
// that has zero countries, so any environment already seeded from the old CSVs never
// gets corrected by re-running the seed.
//
// This script fixes the corrupted `countryId` column in place — by country_code — for
// an already-seeded environment, without truncating or re-inserting any row. Row ids
// are never changed, so it is safe to run even though `organisation.countryId/stateId/
// cityId` are no longer enforced as DB foreign keys (see migration
// 20260527100000_drop_geo_fk_constraints). Not wired into `prisma migrate deploy` —
// run manually, once, against each affected environment.
//
// Usage:
//   DATABASE_URL=... npx ts-node scripts/fix-geo-location-country-ids.ts [--dry-run]

import { PrismaClient } from '@prisma/client';
import { Country } from 'country-state-city';

const prisma = new PrismaClient();
const log = (msg: string): void => console.log(`[GEO-FIX] ${msg}`);

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  log(`Starting geo-location country_id correction${DRY_RUN ? ' (dry run)' : ''}...`);

  const dbCountries = await prisma.countries.findMany();
  const dbCountryByName = new Map(dbCountries.map((c) => [c.name.trim().toLowerCase(), c]));

  const pkgCountries = Country.getAllCountries();

  let isoBackfilled = 0;
  let statesFixed = 0;
  let citiesFixed = 0;
  const unmatched: string[] = [];

  for (const pkgCountry of pkgCountries) {
    const dbCountry = dbCountryByName.get(pkgCountry.name.trim().toLowerCase());
    if (!dbCountry) {
      unmatched.push(pkgCountry.name);
      continue;
    }

    if (!dbCountry.isoCode) {
      log(`  countries.id=${dbCountry.id} (${dbCountry.name}): backfilling iso_code=${pkgCountry.isoCode}`);
      if (!DRY_RUN) {
        await prisma.countries.update({
          where: { id: dbCountry.id },
          data: { isoCode: pkgCountry.isoCode, phonecode: dbCountry.phonecode ?? pkgCountry.phonecode ?? null }
        });
      }
      isoBackfilled++;
    }

    const statesToFix = await prisma.states.count({
      where: { countryCode: pkgCountry.isoCode, countryId: { not: dbCountry.id } }
    });
    if (0 < statesToFix) {
      log(
        `  states with country_code=${pkgCountry.isoCode}: repointing ${statesToFix} row(s) to countryId=${dbCountry.id} (${dbCountry.name})`
      );
      if (!DRY_RUN) {
        await prisma.states.updateMany({
          where: { countryCode: pkgCountry.isoCode, countryId: { not: dbCountry.id } },
          data: { countryId: dbCountry.id }
        });
      }
      statesFixed += statesToFix;
    }

    const citiesToFix = await prisma.cities.count({
      where: { countryCode: pkgCountry.isoCode, countryId: { not: dbCountry.id } }
    });
    if (0 < citiesToFix) {
      log(
        `  cities with country_code=${pkgCountry.isoCode}: repointing ${citiesToFix} row(s) to countryId=${dbCountry.id} (${dbCountry.name})`
      );
      if (!DRY_RUN) {
        await prisma.cities.updateMany({
          where: { countryCode: pkgCountry.isoCode, countryId: { not: dbCountry.id } },
          data: { countryId: dbCountry.id }
        });
      }
      citiesFixed += citiesToFix;
    }
  }

  log('');
  log('========================================');
  log('Summary');
  log('========================================');
  log(`countries.iso_code backfilled: ${isoBackfilled}`);
  log(`states.country_id corrected:   ${statesFixed}`);
  log(`cities.country_id corrected:   ${citiesFixed}`);
  if (0 < unmatched.length) {
    log(`Countries from country-state-city with no matching DB row by name (${unmatched.length}), review manually:`);
    log(`  ${unmatched.join(', ')}`);
  }
  if (DRY_RUN) {
    log('');
    log('Dry run only — no changes were written. Re-run without --dry-run to apply.');
  }
}

main()
  .catch((err) => {
    console.error('[GEO-FIX] FAILED:', err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
