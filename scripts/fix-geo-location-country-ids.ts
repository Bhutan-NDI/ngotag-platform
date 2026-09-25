/* eslint-disable camelcase */
/* eslint-disable no-console */
// One-off corrective data fix for environments seeded before commit a04f80ed
// ("fix: replace broken geo CSV data with country-state-city npm package seed").
//
// The legacy `geo-location-master-data/states.csv` / `cities.csv` files were corrupted:
//   - `states.country_id` / `cities.country_id` were shifted relative to `country_code`
//     for the large majority of rows (e.g. Bosnia and Herzegovina's cantons were stored
//     under Bhutan's country id).
//   - `cities.state_id` pointed at a state in a *different* country for ~93% of rows
//     (e.g. every Bhutan city had state_id=1146, El Salvador's Cuscatlán Department).
// `seedGeoLocationData` in `libs/prisma-service/prisma/seed.ts` only seeds a database
// that has zero countries, so any environment already seeded from the old CSVs never
// gets corrected by re-running the seed.
//
// This script repairs an already-seeded environment in place, without truncating or
// re-inserting any row:
//   1. countries: backfills `iso_code` (matched to country-state-city by name, with an
//      alias map for the few countries whose legacy name differs).
//   2. states: re-points `country_id` by `country_code`, and backfills `iso_code` by
//      matching each state name to country-state-city within its country.
//   3. cities: re-points `country_id` by `country_code`, and re-points `state_id` to the
//      correct state of the same country. The legacy `cities.state_code` values are
//      country-state-city state iso codes, so they're resolved through the package to a
//      state name and from there to the DB state. Where the package no longer has that
//      state code (its state list differs from the legacy one for a few countries, e.g.
//      Spain's provinces vs autonomous communities), it falls back to looking the city
//      name up in the package, then to the state most of the city's `state_code` group
//      resolved to, then to a DB state named after one of the group's cities (a
//      province named after its capital). Cities that still can't be resolved are left
//      unchanged and reported.
//
// Row ids are never changed, so it is safe to run even though `organisation.countryId/
// stateId/cityId` are no longer enforced as DB foreign keys (see migration
// 20260527100000_drop_geo_fk_constraints). Idempotent — re-running only touches rows that
// are still wrong. Not wired into `prisma migrate deploy` — run manually, once, against
// each affected environment.
//
// Usage:
//   DATABASE_URL=... npx ts-node scripts/fix-geo-location-country-ids.ts [--dry-run]

import { City, Country, State } from 'country-state-city';
import { PrismaClient } from '@prisma/client';

const log = (msg: string): void => console.log(`[GEO-FIX] ${msg}`);

// country-state-city iso code → legacy DB country name, for names that differ between the two.
const COUNTRY_NAME_ALIASES: Record<string, string> = {
  GM: 'gambia the',
  MK: 'north macedonia',
  SZ: 'eswatini',
  TL: 'timor-leste'
};

// Minimum similarity for the last-resort fuzzy state name match (e.g. PL "Mazovia" ↔
// "Masovian Voivodeship"). Only considered between states still unmatched in the same country.
const FUZZY_STATE_MATCH_THRESHOLD = 0.75;

const UPDATE_CHUNK_SIZE = 1000;

export interface GeoState {
  id: number;
  name: string;
  countryCode: string;
  isoCode: string;
}

export interface GeoCity {
  id: number;
  name: string;
  stateId: number;
  stateCode: string;
  countryCode: string;
}

export interface CityStatePlan {
  // DB state id → package state iso code, for states whose `iso_code` is empty
  stateIsoBackfills: Map<number, string>;
  // DB city id → correct DB state id, for cities whose `state_id` is wrong
  cityStateUpdates: Map<number, number>;
  resolvedBy: { stateCode: number; cityName: number; groupVote: number; capitalName: number };
  unmatchedStates: GeoState[];
  unresolvedCities: GeoCity[];
}

const normalize = (s: string): string => {
  const withoutDiacritics = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return withoutDiacritics
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const STATE_NAME_NOISE =
  /\b(district|province|region|governorate|county|department|municipality|parish|prefecture|state|oblast|voivodeship|canton|autonomous|city|of|the|division|island|islands|territory|republic)\b/g;

const looseNormalize = (s: string): string => normalize(s).replace(STATE_NAME_NOISE, '').replace(/\s+/g, ' ').trim();

const similarity = (a: string, b: string): number => {
  if (!a.length || !b.length) {
    return 0;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  const distanceRatio = prev[b.length] / Math.max(a.length, b.length);
  return 1 - distanceRatio;
};

const groupBy = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) {
      group.push(item);
    } else {
      groups.set(k, [item]);
    }
  }
  return groups;
};

/**
 * Matches each DB state to its country-state-city iso code (existing `iso_code` first, then
 * exact name, then name without generic words like "District", then fuzzy name), and works out
 * the correct state for every city. Pure — does not touch the database.
 */
export function planCityStateRepair(states: GeoState[], cities: GeoCity[]): CityStatePlan {
  const stateIsoById = new Map<number, string>();
  const stateIsoBackfills = new Map<number, string>();
  const unmatchedStates: GeoState[] = [];

  for (const [countryCode, countryStates] of groupBy(states, (s) => s.countryCode)) {
    const pkgStates = State.getStatesOfCountry(countryCode);
    const usedIso = new Set<string>();

    for (const s of countryStates) {
      if (s.isoCode && !usedIso.has(s.isoCode)) {
        stateIsoById.set(s.id, s.isoCode);
        usedIso.add(s.isoCode);
      }
    }

    const matchPass = (matches: (pkgName: string, dbName: string) => boolean): void => {
      for (const s of countryStates) {
        if (stateIsoById.has(s.id)) {
          continue;
        }
        const candidates = pkgStates.filter((p) => !usedIso.has(p.isoCode) && matches(p.name, s.name));
        if (1 === candidates.length) {
          stateIsoById.set(s.id, candidates[0].isoCode);
          stateIsoBackfills.set(s.id, candidates[0].isoCode);
          usedIso.add(candidates[0].isoCode);
        }
      }
    };
    matchPass((pkgName, dbName) => normalize(pkgName) === normalize(dbName));
    matchPass((pkgName, dbName) => '' !== looseNormalize(dbName) && looseNormalize(pkgName) === looseNormalize(dbName));

    for (const s of countryStates) {
      if (stateIsoById.has(s.id)) {
        continue;
      }
      const scored = pkgStates
        .filter((p) => !usedIso.has(p.isoCode))
        .map((p) => ({ isoCode: p.isoCode, score: similarity(looseNormalize(p.name), looseNormalize(s.name)) }))
        .sort((a, b) => b.score - a.score);
      const [best, runnerUp] = scored;
      if (best && best.score >= FUZZY_STATE_MATCH_THRESHOLD && (!runnerUp || runnerUp.score < best.score)) {
        stateIsoById.set(s.id, best.isoCode);
        stateIsoBackfills.set(s.id, best.isoCode);
        usedIso.add(best.isoCode);
      } else {
        unmatchedStates.push(s);
      }
    }
  }

  // "countryCode|stateIsoCode" → DB state id
  const stateIdByKey = new Map<string, number>();
  for (const s of states) {
    const iso = stateIsoById.get(s.id);
    if (iso) {
      stateIdByKey.set(`${s.countryCode}|${iso}`, s.id);
    }
  }

  // countryCode → normalized package city name → package state iso codes it appears under
  const pkgCityIndex = new Map<string, Map<string, Set<string>>>();
  const pkgStateCodesForCity = (countryCode: string, cityName: string): Set<string> | undefined => {
    let index = pkgCityIndex.get(countryCode);
    if (!index) {
      index = new Map();
      for (const c of City.getCitiesOfCountry(countryCode) ?? []) {
        const k = normalize(c.name);
        const codes = index.get(k) ?? new Set<string>();
        codes.add(c.stateCode);
        index.set(k, codes);
      }
      pkgCityIndex.set(countryCode, index);
    }
    return index.get(normalize(cityName));
  };
  const resolveByCityName = (city: GeoCity): number | undefined => {
    const candidates = new Set<number>();
    for (const code of pkgStateCodesForCity(city.countryCode, city.name) ?? []) {
      const id = stateIdByKey.get(`${city.countryCode}|${code}`);
      if (id) {
        candidates.add(id);
      }
    }
    return 1 === candidates.size ? [...candidates][0] : undefined;
  };

  const resolved = new Map<number, number>();
  const resolvedBy = { stateCode: 0, cityName: 0, groupVote: 0, capitalName: 0 };
  const unresolvedGroups: GeoCity[][] = [];

  for (const [key, group] of groupBy(cities, (c) => `${c.countryCode}|${c.stateCode}`)) {
    const byCode = stateIdByKey.get(key);
    if (byCode) {
      group.forEach((c) => resolved.set(c.id, byCode));
      resolvedBy.stateCode += group.length;
      continue;
    }

    const votes = new Map<number, number>();
    const pending: GeoCity[] = [];
    for (const c of group) {
      const id = resolveByCityName(c);
      if (id) {
        resolved.set(c.id, id);
        votes.set(id, (votes.get(id) ?? 0) + 1);
        resolvedBy.cityName++;
      } else {
        pending.push(c);
      }
    }

    const totalVotes = group.length - pending.length;
    const [winner] = [...votes].sort((a, b) => b[1] - a[1]);
    if (winner && 0.5 < winner[1] / totalVotes) {
      pending.forEach((c) => resolved.set(c.id, winner[0]));
      resolvedBy.groupVote += pending.length;
    } else if (pending.length) {
      unresolvedGroups.push(pending);
    }
  }

  // Last resort: a remaining group whose cities include one named exactly like a state of the
  // same country that no city group has claimed yet (e.g. legacy ES province "Barcelona" for
  // state_code "B", which country-state-city no longer lists as a state).
  const claimedStateIds = new Set(resolved.values());
  const statesByCountry = groupBy(states, (s) => s.countryCode);
  const unresolvedCities: GeoCity[] = [];
  for (const group of unresolvedGroups) {
    const cityNames = new Set(group.map((c) => normalize(c.name)));
    const candidates = (statesByCountry.get(group[0].countryCode) ?? []).filter(
      (s) => !claimedStateIds.has(s.id) && cityNames.has(normalize(s.name))
    );
    if (1 === candidates.length) {
      group.forEach((c) => resolved.set(c.id, candidates[0].id));
      claimedStateIds.add(candidates[0].id);
      resolvedBy.capitalName += group.length;
    } else {
      unresolvedCities.push(...group);
    }
  }

  const cityStateUpdates = new Map<number, number>();
  for (const c of cities) {
    const stateId = resolved.get(c.id);
    if (stateId && stateId !== c.stateId) {
      cityStateUpdates.set(c.id, stateId);
    }
  }

  return { stateIsoBackfills, cityStateUpdates, resolvedBy, unmatchedStates, unresolvedCities };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const DRY_RUN = process.argv.includes('--dry-run');

  try {
    log(`Starting geo-location correction${DRY_RUN ? ' (dry run)' : ''}...`);

    const dbCountries = await prisma.countries.findMany();
    const dbCountryByName = new Map(dbCountries.map((c) => [c.name.trim().toLowerCase(), c]));

    let isoBackfilled = 0;
    let statesFixed = 0;
    let citiesFixed = 0;
    const unmatched: string[] = [];

    // -----------------------------------------------------------------------
    // 1. countries.iso_code + states/cities.country_id, by country_code
    // -----------------------------------------------------------------------
    for (const pkgCountry of Country.getAllCountries()) {
      const dbCountry =
        dbCountryByName.get(pkgCountry.name.trim().toLowerCase()) ??
        dbCountryByName.get(COUNTRY_NAME_ALIASES[pkgCountry.isoCode] ?? '');
      if (!dbCountry) {
        unmatched.push(`${pkgCountry.name} (${pkgCountry.isoCode})`);
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

    // -----------------------------------------------------------------------
    // 2. states.iso_code + cities.state_id
    // -----------------------------------------------------------------------
    log('Resolving cities.state_id...');
    const states = await prisma.states.findMany({ select: { id: true, name: true, countryCode: true, isoCode: true } });
    const cities = await prisma.cities.findMany({
      select: { id: true, name: true, stateId: true, stateCode: true, countryCode: true }
    });
    const plan = planCityStateRepair(states, cities);

    if (!DRY_RUN) {
      for (const [stateId, isoCode] of plan.stateIsoBackfills) {
        await prisma.states.update({ where: { id: stateId }, data: { isoCode } });
      }
    }

    const cityIdsByNewState = groupBy([...plan.cityStateUpdates], ([, stateId]) => String(stateId));
    const citiesPerCountry = new Map<string, number>();
    const countryCodeByStateId = new Map(states.map((s) => [s.id, s.countryCode]));
    for (const [key, updates] of cityIdsByNewState) {
      const stateId = Number(key);
      const cityIds = updates.map(([cityId]) => cityId);
      const cc = countryCodeByStateId.get(stateId) ?? '?';
      citiesPerCountry.set(cc, (citiesPerCountry.get(cc) ?? 0) + cityIds.length);
      if (!DRY_RUN) {
        for (let i = 0; i < cityIds.length; i += UPDATE_CHUNK_SIZE) {
          await prisma.cities.updateMany({
            where: { id: { in: cityIds.slice(i, i + UPDATE_CHUNK_SIZE) } },
            data: { stateId }
          });
        }
      }
    }
    for (const [cc, count] of [...citiesPerCountry].sort()) {
      log(`  cities with country_code=${cc}: repointing state_id on ${count} row(s)`);
    }

    log('');
    log('========================================');
    log('Summary');
    log('========================================');
    log(`countries.iso_code backfilled: ${isoBackfilled}`);
    log(`states.country_id corrected:   ${statesFixed}`);
    log(`states.iso_code backfilled:    ${plan.stateIsoBackfills.size}`);
    log(`cities.country_id corrected:   ${citiesFixed}`);
    log(`cities.state_id corrected:     ${plan.cityStateUpdates.size}`);
    const by = plan.resolvedBy;
    log(
      `  resolved via state_code=${by.stateCode}, city name=${by.cityName}, group vote=${by.groupVote}, capital name=${by.capitalName}`
    );
    if (0 < plan.unmatchedStates.length) {
      log(`States with no country-state-city match (${plan.unmatchedStates.length}) — iso_code left empty:`);
      log(`  ${plan.unmatchedStates.map((s) => `${s.countryCode}:${s.name}`).join(', ')}`);
    }
    if (0 < plan.unresolvedCities.length) {
      const groups = [...groupBy(plan.unresolvedCities, (c) => `${c.countryCode}:${c.stateCode}`)]
        .map(([key, group]) => `${key} (${group.length})`)
        .join(', ');
      log(`Cities whose state could not be resolved (${plan.unresolvedCities.length}) — state_id left unchanged:`);
      log(`  by country_code:state_code: ${groups}`);
    }
    if (0 < unmatched.length) {
      log(`Countries from country-state-city with no matching DB row (${unmatched.length}), review manually:`);
      log(`  ${unmatched.join(', ')}`);
      process.exitCode = 1;
    }
    if (DRY_RUN) {
      log('');
      log('Dry run only — no changes were written. Re-run without --dry-run to apply.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[GEO-FIX] FAILED:', err.message || err);
    process.exit(1);
  });
}
