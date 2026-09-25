import { State } from 'country-state-city';
import {
  DbCity,
  DbState,
  loadDzongkhags,
  planBhutanSync,
  syncBhutanAddress
} from '../libs/prisma-service/prisma/bhutan-address';

const BT = 26;
const dzongkhags = loadDzongkhags();

// Legacy rows as seeded from country-state-city (Trashiyangtse came from a seed patch).
const legacyStates: DbState[] = [
  { id: 438, name: 'Bumthang District', isoCode: '33', countryId: BT },
  { id: 439, name: 'Chukha District', isoCode: '12', countryId: BT },
  { id: 443, name: 'Lhuntse District', isoCode: '44', countryId: BT },
  { id: 444, name: 'Mongar District', isoCode: '42', countryId: BT },
  { id: 448, name: 'Samdrup Jongkhar District', isoCode: '45', countryId: BT },
  { id: 457, name: 'Trashiyangtse District', isoCode: 'TY', countryId: BT }
];
const legacyCities: DbCity[] = [
  { id: 1, name: 'Jakar', stateId: 438, stateCode: '33', countryId: BT },
  { id: 2, name: 'Mongar', stateId: 444, stateCode: '42', countryId: BT }
];

describe('planBhutanSync', () => {
  const plan = planBhutanSync(dzongkhags, BT, legacyStates, legacyCities);

  it('renames legacy states in place, keeping their ids', () => {
    expect(plan.stateUpdates).toEqual(
      expect.arrayContaining([
        { id: 438, name: 'Bumthang', isoCode: '01', countryId: BT },
        { id: 443, name: 'Lhuentse', isoCode: '06', countryId: BT },
        { id: 448, name: 'Samdrupjongkhar', isoCode: '11', countryId: BT },
        { id: 457, name: 'Trashiyangtse', isoCode: '16', countryId: BT }
      ])
    );
    expect(plan.stateDeletes).toEqual([]);
    expect(plan.stateCreates).toHaveLength(dzongkhags.length - legacyStates.length);
  });

  it('keeps legacy cities that match a gewog and drops the rest', () => {
    expect(plan.cityUpdates).toEqual([{ id: 2, name: 'Mongar', stateId: 444, stateCode: '07' }]);
    expect(plan.cityDeletes).toEqual([1]);
    const gewogCount = dzongkhags.reduce((n, dz) => n + dz.gewogs.length, 0);
    expect(plan.cityCreates).toHaveLength(gewogCount - 1);
  });

  it('maps every legacy package state to its own dzongkhag, though legacy iso codes overlap dzongkhag ids', () => {
    const pkgStates: DbState[] = [
      ...State.getStatesOfCountry('BT'),
      { name: 'Trashiyangtse District', isoCode: 'TY' }
    ].map((st, i) => ({ id: i + 1, name: st.name, isoCode: st.isoCode, countryId: BT }));
    const full = planBhutanSync(dzongkhags, BT, pkgStates, []);
    expect(full.stateDeletes).toEqual([]);
    expect(full.stateCreates).toEqual([]);
    const renamed = new Map(full.stateUpdates.map((u) => [u.id, u.name]));
    const loose = (name: string): string =>
      name
        .toLowerCase()
        .replace(' district', '')
        .replace(/[^a-z]/g, '');
    const aliases: Record<string, string> = { lhuntse: 'lhuentse' };
    for (const st of pkgStates) {
      expect(loose(renamed.get(st.id))).toBe(aliases[loose(st.name)] ?? loose(st.name));
    }
  });

  it('is a no-op once synced', () => {
    let nextId = 1000;
    const states: DbState[] = dzongkhags.map((dz) => ({
      id: nextId++,
      name: dz.dzongkhagName,
      isoCode: dz.dzongkhagId,
      countryId: BT
    }));
    const cities: DbCity[] = dzongkhags.flatMap((dz, i) =>
      dz.gewogs.map((g) => ({
        id: nextId++,
        name: g.gewogName,
        stateId: states[i].id,
        stateCode: dz.dzongkhagId,
        countryId: BT
      }))
    );
    const synced = planBhutanSync(dzongkhags, BT, states, cities);
    expect(Object.values(synced).every((list) => 0 === list.length)).toBe(true);
  });
});

// Applies a plan to in-memory rows the way syncBhutanAddress does to the database.
function applyPlan(states: DbState[], cities: DbCity[]): { states: DbState[]; cities: DbCity[] } {
  const plan = planBhutanSync(dzongkhags, BT, states, cities);
  let nextId = 100000;
  const outStates = new Map(states.map((s) => [s.id, { ...s }]));
  const outCities = new Map(cities.map((c) => [c.id, { ...c }]));
  plan.stateUpdates.forEach((u) => Object.assign(outStates.get(u.id), u));
  const createdStateIds = new Map<string, number>();
  for (const dz of plan.stateCreates) {
    const id = nextId++;
    outStates.set(id, { id, name: dz.dzongkhagName, isoCode: dz.dzongkhagId, countryId: BT });
    createdStateIds.set(dz.dzongkhagId, id);
  }
  plan.cityDeletes.forEach((id) => outCities.delete(id));
  plan.stateDeletes.forEach((id) => outStates.delete(id));
  plan.cityUpdates.forEach((u) => Object.assign(outCities.get(u.id), u, { countryId: BT }));
  for (const c of plan.cityCreates) {
    const id = nextId++;
    const stateId = c.stateId ?? createdStateIds.get(c.stateCode);
    outCities.set(id, { id, name: c.name, stateId, stateCode: c.stateCode, countryId: BT });
  }
  return { states: [...outStates.values()], cities: [...outCities.values()] };
}

const expected = dzongkhags
  .map(
    (dz) =>
      `${dz.dzongkhagId} ${dz.dzongkhagName}: ${dz.gewogs
        .map((g) => g.gewogName)
        .sort()
        .join(', ')}`
  )
  .sort();

const actual = ({ states, cities }: { states: DbState[]; cities: DbCity[] }): string[] =>
  states
    .map((s) => {
      const gewogs = cities.filter((c) => c.stateId === s.id);
      expect(s.countryId).toBe(BT);
      expect(gewogs.every((c) => c.stateCode === s.isoCode && c.countryId === BT)).toBe(true);
      return `${s.isoCode} ${s.name}: ${gewogs
        .map((c) => c.name)
        .sort()
        .join(', ')}`;
    })
    .sort();

describe('syncing leaves exactly the dzongkhags and gewogs in the address JSON', () => {
  it('has all 20 dzongkhags and 237 gewogs in the JSON', () => {
    expect(dzongkhags).toHaveLength(20);
    expect(dzongkhags.reduce((n, dz) => n + dz.gewogs.length, 0)).toBe(237);
  });

  it('from an empty Bhutan', () => {
    expect(actual(applyPlan([], []))).toEqual(expected);
  });

  it('from the legacy country-state-city rows', () => {
    expect(actual(applyPlan(legacyStates, legacyCities))).toEqual(expected);
  });

  it('from rows with stray states, stray cities and a city under the wrong state', () => {
    const states: DbState[] = [...legacyStates, { id: 900, name: 'Nowhere Province', isoCode: 'XX', countryId: BT }];
    const cities: DbCity[] = [
      ...legacyCities,
      { id: 901, name: 'Stray Town', stateId: 900, stateCode: 'XX', countryId: BT },
      { id: 902, name: 'Ura', stateId: 439, stateCode: '12', countryId: BT }
    ];
    expect(actual(applyPlan(states, cities))).toEqual(expected);
  });

  it('from legacy rows whose country_id is shifted to another country', () => {
    const shifted = legacyStates.map((st) => ({ ...st, countryId: BT + 1 }));
    expect(actual(applyPlan(shifted, legacyCities))).toEqual(expected);
    expect(planBhutanSync(dzongkhags, BT, shifted, legacyCities).stateUpdates.every((u) => u.countryId === BT)).toBe(
      true
    );
  });

  it('when run twice', () => {
    expect(
      actual(applyPlan(...(Object.values(applyPlan(legacyStates, legacyCities)) as [DbState[], DbCity[]])))
    ).toEqual(expected);
  });
});

describe('syncBhutanAddress', () => {
  it("reads and deletes only Bhutan rows, even when another country's city points at a Bhutan state", async () => {
    const states = [{ id: 438, name: 'Bumthang District', isoCode: '33', countryId: BT }];
    // Legacy-DB city of another country whose state_id is shifted onto a Bhutan state
    const cities = [
      { id: 1, name: 'Jakar', stateId: 438, stateCode: '33', countryId: BT, countryCode: 'BT' },
      { id: 2, name: 'Skopje', stateId: 438, stateCode: '85', countryId: 150, countryCode: 'MK' }
    ];
    const prisma = {
      countries: { findFirst: jest.fn().mockResolvedValue({ id: BT, isoCode: 'BT' }) },
      states: { findMany: jest.fn().mockResolvedValue(states) },
      cities: {
        findMany: jest.fn(({ where }) => Promise.resolve(cities.filter((c) => c.countryCode === where.countryCode)))
      },
      organisation: { count: jest.fn().mockResolvedValue(0) }
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await syncBhutanAddress(prisma as any, { dryRun: true });

    expect(prisma.states.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { countryCode: 'BT' } }));
    expect(prisma.cities.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { countryCode: 'BT' } }));
    expect(plan.cityDeletes).toEqual([1]);
  });
});
