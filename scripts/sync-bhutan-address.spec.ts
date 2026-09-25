import { DbCity, DbState, loadDzongkhags, planBhutanSync } from '../libs/prisma-service/prisma/bhutan-address';

const BT = 26;
const dzongkhags = loadDzongkhags();

// Legacy rows as seeded from country-state-city (Trashiyangtse came from a seed patch).
const legacyStates: DbState[] = [
  { id: 438, name: 'Bumthang District', isoCode: '33' },
  { id: 439, name: 'Chukha District', isoCode: '12' },
  { id: 443, name: 'Lhuntse District', isoCode: '44' },
  { id: 444, name: 'Mongar District', isoCode: '42' },
  { id: 448, name: 'Samdrup Jongkhar District', isoCode: '45' },
  { id: 457, name: 'Trashiyangtse District', isoCode: 'TY' }
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
        { id: 438, name: 'Bumthang', isoCode: '01' },
        { id: 443, name: 'Lhuentse', isoCode: '06' },
        { id: 448, name: 'Samdrupjongkhar', isoCode: '11' },
        { id: 457, name: 'Trashiyangtse', isoCode: '16' }
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

  it('is a no-op once synced', () => {
    let nextId = 1000;
    const states: DbState[] = dzongkhags.map((dz) => ({
      id: nextId++,
      name: dz.dzongkhagName,
      isoCode: dz.dzongkhagId
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
    outStates.set(id, { id, name: dz.dzongkhagName, isoCode: dz.dzongkhagId });
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
    const states: DbState[] = [...legacyStates, { id: 900, name: 'Nowhere Province', isoCode: 'XX' }];
    const cities: DbCity[] = [
      ...legacyCities,
      { id: 901, name: 'Stray Town', stateId: 900, stateCode: 'XX', countryId: BT },
      { id: 902, name: 'Ura', stateId: 439, stateCode: '12', countryId: BT }
    ];
    expect(actual(applyPlan(states, cities))).toEqual(expected);
  });

  it('when run twice', () => {
    expect(
      actual(applyPlan(...(Object.values(applyPlan(legacyStates, legacyCities)) as [DbState[], DbCity[]])))
    ).toEqual(expected);
  });
});
