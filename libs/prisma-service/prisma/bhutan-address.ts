/* eslint-disable no-console */
// Bhutan's states and cities come from the national address master (dzongkhags → states,
// gewogs → cities) instead of the country-state-city package. The sync updates existing rows in
// place so ids referenced by organisation.state_id / city_id survive; idempotent.
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

export const BHUTAN_COUNTRY_CODE = 'BT';

const ADDRESS_FILE = path.join(__dirname, 'data/geo-location-master-data/bhutan-address.json');

export interface Dzongkhag {
  dzongkhagId: string;
  dzongkhagName: string;
  gewogs: { gewogId: string; gewogName: string }[];
}

export const loadDzongkhags = (): Dzongkhag[] => JSON.parse(fs.readFileSync(ADDRESS_FILE, 'utf8')).dzongkhags;

// Legacy (country-state-city) state names that differ from the dzongkhag name beyond "District".
const LEGACY_STATE_ALIASES: Record<string, string> = {
  lhuntse: 'lhuentse'
};

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\bdistrict\b/g, '')
    .replace(/[^a-z0-9]/g, '');

const stateKey = (name: string): string => LEGACY_STATE_ALIASES[normalize(name)] ?? normalize(name);

export interface DbState {
  id: number;
  name: string;
  isoCode: string;
  countryId: number;
}

export interface DbCity {
  id: number;
  name: string;
  stateId: number;
  stateCode: string;
  countryId: number;
}

export interface BhutanSyncPlan {
  stateUpdates: { id: number; name: string; isoCode: string; countryId: number }[];
  stateCreates: Dzongkhag[];
  stateDeletes: number[];
  cityUpdates: { id: number; name: string; stateId: number; stateCode: string }[];
  // stateId is undefined for gewogs of a dzongkhag that is itself being created
  cityCreates: { name: string; stateId?: number; stateCode: string }[];
  cityDeletes: number[];
}

/**
 * Matches existing Bhutan states to dzongkhags by name and existing cities to
 * gewogs of the same dzongkhag (by name). Anything unmatched is deleted. Pure — no database access.
 */
export function planBhutanSync(
  dzongkhags: Dzongkhag[],
  countryId: number,
  states: DbState[],
  cities: DbCity[]
): BhutanSyncPlan {
  const plan: BhutanSyncPlan = {
    stateUpdates: [],
    stateCreates: [],
    stateDeletes: [],
    cityUpdates: [],
    cityCreates: [],
    cityDeletes: []
  };

  const unmatchedStates = new Map(states.map((s) => [s.id, s]));
  const stateIdByDzongkhag = new Map<string, number>();
  const claimState = (dz: Dzongkhag, match: (s: DbState) => boolean): void => {
    if (stateIdByDzongkhag.has(dz.dzongkhagId)) {
      return;
    }
    const state = [...unmatchedStates.values()].find(match);
    if (state) {
      stateIdByDzongkhag.set(dz.dzongkhagId, state.id);
      unmatchedStates.delete(state.id);
      if (state.name !== dz.dzongkhagName || state.isoCode !== dz.dzongkhagId || state.countryId !== countryId) {
        plan.stateUpdates.push({ id: state.id, name: dz.dzongkhagName, isoCode: dz.dzongkhagId, countryId });
      }
    }
  };
  // By name only: legacy iso codes overlap dzongkhag ids (Paro District is "11", Samdrupjongkhar's id).
  dzongkhags.forEach((dz) => claimState(dz, (s) => stateKey(s.name) === normalize(dz.dzongkhagName)));
  plan.stateDeletes = [...unmatchedStates.keys()];

  const citiesByState = new Map<number, DbCity[]>();
  for (const city of cities) {
    citiesByState.set(city.stateId, [...(citiesByState.get(city.stateId) ?? []), city]);
  }
  const keptCityIds = new Set<number>();

  for (const dz of dzongkhags) {
    const stateId = stateIdByDzongkhag.get(dz.dzongkhagId);
    if (stateId === undefined) {
      plan.stateCreates.push(dz);
    }
    const existing = [...(citiesByState.get(stateId) ?? [])];
    for (const gewog of dz.gewogs) {
      const idx = existing.findIndex((c) => normalize(c.name) === normalize(gewog.gewogName));
      if (-1 === idx) {
        plan.cityCreates.push({ name: gewog.gewogName, stateId, stateCode: dz.dzongkhagId });
        continue;
      }
      const [city] = existing.splice(idx, 1);
      keptCityIds.add(city.id);
      if (city.name !== gewog.gewogName || city.stateCode !== dz.dzongkhagId || city.countryId !== countryId) {
        plan.cityUpdates.push({ id: city.id, name: gewog.gewogName, stateId, stateCode: dz.dzongkhagId });
      }
    }
  }
  plan.cityDeletes = cities.filter((c) => !keptCityIds.has(c.id)).map((c) => c.id);

  return plan;
}

/**
 * Rewrites Bhutan's states/cities to match the address master. Rows are selected by country_code,
 * not country_id, which is shifted on databases seeded from the legacy CSVs. Organisations pointing
 * at a deleted state/city have that reference cleared here, since organisation has no geo FKs
 * (dropped in 20260527100000_drop_geo_fk_constraints).
 */
export async function syncBhutanAddress(prisma: PrismaClient, { dryRun = false } = {}): Promise<BhutanSyncPlan> {
  const log = (msg: string): void => console.log(`[BHUTAN-ADDRESS] ${msg}`);

  const country = await prisma.countries.findFirst({ where: { isoCode: BHUTAN_COUNTRY_CODE } });
  if (!country) {
    log('Bhutan not found in countries (iso_code=BT). Skipping.');
    return undefined;
  }

  const states = await prisma.states.findMany({
    where: { countryCode: BHUTAN_COUNTRY_CODE },
    select: { id: true, name: true, isoCode: true, countryId: true }
  });
  const cities = await prisma.cities.findMany({
    // Not by state_id: on legacy DBs some other countries' cities still point at Bhutan states.
    where: { countryCode: BHUTAN_COUNTRY_CODE },
    select: { id: true, name: true, stateId: true, stateCode: true, countryId: true }
  });
  const plan = planBhutanSync(loadDzongkhags(), country.id, states, cities);

  const affectedOrgs = await prisma.organisation.count({
    where: { OR: [{ stateId: { in: plan.stateDeletes } }, { cityId: { in: plan.cityDeletes } }] }
  });
  log(
    `states: ${plan.stateUpdates.length} updated, ${plan.stateCreates.length} created, ${plan.stateDeletes.length} deleted; ` +
      `cities: ${plan.cityUpdates.length} updated, ${plan.cityCreates.length} created, ${plan.cityDeletes.length} deleted`
  );
  if (0 < affectedOrgs) {
    log(`${affectedOrgs} organisation(s) reference a deleted state/city; that reference will be cleared.`);
  }

  const hasChanges = Object.values(plan).some((list) => 0 < list.length);
  if (dryRun || !hasChanges) {
    return plan;
  }

  await prisma.$transaction(
    async (tx) => {
      for (const s of plan.stateUpdates) {
        await tx.states.update({
          where: { id: s.id },
          data: { name: s.name, isoCode: s.isoCode, countryId: s.countryId }
        });
      }
      const createdStateIds = new Map<string, number>();
      for (const dz of plan.stateCreates) {
        const created = await tx.states.create({
          data: {
            name: dz.dzongkhagName,
            isoCode: dz.dzongkhagId,
            countryId: country.id,
            countryCode: BHUTAN_COUNTRY_CODE
          }
        });
        createdStateIds.set(dz.dzongkhagId, created.id);
      }
      await tx.organisation.updateMany({ where: { cityId: { in: plan.cityDeletes } }, data: { cityId: null } });
      await tx.organisation.updateMany({ where: { stateId: { in: plan.stateDeletes } }, data: { stateId: null } });
      await tx.cities.deleteMany({ where: { id: { in: plan.cityDeletes } } });
      await tx.states.deleteMany({ where: { id: { in: plan.stateDeletes } } });
      for (const c of plan.cityUpdates) {
        await tx.cities.update({
          where: { id: c.id },
          data: { name: c.name, stateId: c.stateId, stateCode: c.stateCode, countryId: country.id }
        });
      }
      await tx.cities.createMany({
        data: plan.cityCreates.map((c) => ({
          name: c.name,
          stateId: c.stateId ?? createdStateIds.get(c.stateCode),
          stateCode: c.stateCode,
          countryId: country.id,
          countryCode: BHUTAN_COUNTRY_CODE
        }))
      });
    },
    { timeout: 60000 }
  );

  return plan;
}
