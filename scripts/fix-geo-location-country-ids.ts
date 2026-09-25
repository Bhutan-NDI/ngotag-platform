/* eslint-disable camelcase */
/* eslint-disable no-console */
// One-off repair for environments seeded from the legacy geo CSVs, whose states/cities
// country_id and cities.state_id are corrupted. The seed skips non-empty tables, so
// re-seeding can't fix them. Updates rows in place (ids unchanged); idempotent.
//
// Usage: DATABASE_URL=... npx ts-node scripts/fix-geo-location-country-ids.ts [--dry-run]

import { City, Country, IState, State } from 'country-state-city';
import { PrismaClient } from '@prisma/client';

const log = (msg: string): void => console.log(`[GEO-FIX] ${msg}`);

// country-state-city iso code → legacy DB country name, for names that differ between the two.
const COUNTRY_NAME_ALIASES: Record<string, string> = {
  GM: 'gambia the',
  MK: 'north macedonia',
  SZ: 'eswatini',
  TL: 'timor-leste'
};

// country code → state iso code → legacy DB state name, where name matching can't link them: English
// names unlike the package's (PL "Upper Silesia" is Opole Voivodeship), or a state the package
// doesn't list (HU Komárom-Esztergom, whose cities would otherwise go to its capital Tatabánya).
const STATE_NAME_ALIASES: Record<string, Record<string, string>> = {
  HU: { KE: 'Komárom-Esztergom' },
  PL: { OP: 'Upper Silesia', PK: 'Subcarpathia', SK: 'Holy Cross' }
};

// Minimum similarity for the fuzzy state name match (e.g. PL "Mazovia" ↔ "Masovian Voivodeship").
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
  resolvedBy: { stateCode: number; groupVote: number; capitalName: number };
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

// Word order ignored, for names like legacy city "Coruña A" vs state "A Coruña".
const wordSetKey = (s: string): string => normalize(s).split(' ').sort().join(' ');

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

    const matchPass = (matches: (pkg: IState, dbName: string) => boolean): void => {
      for (const s of countryStates) {
        if (stateIsoById.has(s.id)) {
          continue;
        }
        const candidates = pkgStates.filter((p) => !usedIso.has(p.isoCode) && matches(p, s.name));
        if (1 === candidates.length) {
          stateIsoById.set(s.id, candidates[0].isoCode);
          stateIsoBackfills.set(s.id, candidates[0].isoCode);
          usedIso.add(candidates[0].isoCode);
        }
      }
    };
    const aliases = STATE_NAME_ALIASES[countryCode] ?? {};
    matchPass((pkg, dbName) => normalize(aliases[pkg.isoCode] ?? '') === normalize(dbName));
    matchPass((pkg, dbName) => normalize(pkg.name) === normalize(dbName));
    matchPass((pkg, dbName) => '' !== looseNormalize(dbName) && looseNormalize(pkg.name) === looseNormalize(dbName));

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
  // A city votes for a DB state only when every package state it appears under maps to that same
  // DB state. If one of them has no DB state (e.g. ES Catalonia, which the legacy DB splits into
  // provinces), a same-named city in another state would otherwise look like a unique match.
  const voteByCityName = (city: GeoCity): number | undefined => {
    const codes = pkgStateCodesForCity(city.countryCode, city.name);
    if (!codes) {
      return undefined;
    }
    const candidates = new Set<number>();
    for (const code of codes) {
      const id = stateIdByKey.get(`${city.countryCode}|${code}`);
      if (!id) {
        return undefined;
      }
      candidates.add(id);
    }
    return 1 === candidates.size ? [...candidates][0] : undefined;
  };

  // Every city in a (country_code, state_code) group belongs to the same legacy state, so each
  // group is resolved as a whole, and a DB state is given to at most one group.
  const groups = groupBy(cities, (c) => `${c.countryCode}|${c.stateCode}`);
  const stateIdByGroup = new Map<string, number>();
  const claimedStateIds = new Set<number>();
  const resolvedBy = { stateCode: 0, groupVote: 0, capitalName: 0 };

  const assign = (assignments: Map<string, number>, method: keyof typeof resolvedBy): void => {
    const groupsPerState = new Map<number, number>();
    for (const stateId of assignments.values()) {
      groupsPerState.set(stateId, (groupsPerState.get(stateId) ?? 0) + 1);
    }
    for (const [key, stateId] of assignments) {
      // Several groups picking the same state (e.g. ES Alicante, Castellón and Valencia all voting
      // for DB "Valencia", matched to the package's whole Valencian Community) means none of them
      // is a reliable match — leave them all for the next step.
      if (1 === groupsPerState.get(stateId) && !claimedStateIds.has(stateId)) {
        stateIdByGroup.set(key, stateId);
        claimedStateIds.add(stateId);
        resolvedBy[method] += groups.get(key)?.length ?? 0;
      }
    }
  };
  const pendingGroups = (): [string, GeoCity[]][] => [...groups].filter(([key]) => !stateIdByGroup.has(key));

  // 1. The legacy state_code is the package state iso code, sometimes without the package's
  //    leading zero (PH "3" is "03" Central Luzon, IR "5" is "05" Kermanshah).
  const statesByCountry = groupBy(states, (s) => s.countryCode);
  const byStateCode = new Map<string, number>();
  for (const [key, [{ countryCode, stateCode }]] of groups) {
    const alias = STATE_NAME_ALIASES[countryCode]?.[stateCode];
    const stateId =
      stateIdByKey.get(key) ??
      stateIdByKey.get(`${countryCode}|${stateCode.padStart(2, '0')}`) ??
      (alias && statesByCountry.get(countryCode)?.find((s) => normalize(s.name) === normalize(alias))?.id);
    if (stateId) {
      byStateCode.set(key, stateId);
    }
  }
  assign(byStateCode, 'stateCode');

  // 2. The state most of the group's cities are found under in the package, by city name. The
  //    winner must cover a majority of the whole group, not just of the cities that voted.
  const byVote = new Map<string, number>();
  for (const [key, group] of pendingGroups()) {
    const votes = new Map<number, number>();
    for (const c of group) {
      const stateId = voteByCityName(c);
      if (stateId) {
        votes.set(stateId, (votes.get(stateId) ?? 0) + 1);
      }
    }
    const [winner] = [...votes].sort((a, b) => b[1] - a[1]);
    if (winner && group.length < 2 * winner[1]) {
      byVote.set(key, winner[0]);
    }
  }
  assign(byVote, 'groupVote');

  // 3. An unclaimed state of the same country named after one of the group's cities — a province
  //    named after its capital (e.g. ES state_code "B" → "Barcelona"). Each round assigns exact
  //    names first, so a prefix match (e.g. "CS" → "Castellón" via "Castellón de la Plana") can't
  //    block one. Rounds repeat until nothing changes, since claiming a state can leave another
  //    group with a single candidate (ES "V" also has a town named "Alicante").
  const capitalPass = (matches: (cityName: string, stateName: string) => boolean): void => {
    const byCapital = new Map<string, number>();
    for (const [key, group] of pendingGroups()) {
      const candidates = (statesByCountry.get(group[0].countryCode) ?? []).filter(
        (s) => !claimedStateIds.has(s.id) && group.some((c) => matches(c.name, s.name))
      );
      if (1 === candidates.length) {
        byCapital.set(key, candidates[0].id);
      }
    }
    assign(byCapital, 'capitalName');
  };
  let claimedBefore: number;
  do {
    claimedBefore = claimedStateIds.size;
    capitalPass((cityName, stateName) => wordSetKey(cityName) === wordSetKey(stateName));
    capitalPass((cityName, stateName) => normalize(cityName).startsWith(`${normalize(stateName)} `));
  } while (claimedStateIds.size > claimedBefore);

  const cityStateUpdates = new Map<number, number>();
  const unresolvedCities: GeoCity[] = [];
  for (const c of cities) {
    const stateId = stateIdByGroup.get(`${c.countryCode}|${c.stateCode}`);
    if (!stateId) {
      unresolvedCities.push(c);
    } else if (stateId !== c.stateId) {
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
    log(`  resolved via state_code=${by.stateCode}, group vote=${by.groupVote}, capital name=${by.capitalName}`);
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
      process.exitCode = 1;
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
