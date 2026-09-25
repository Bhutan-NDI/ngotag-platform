import { GeoCity, GeoState, planCityStateRepair } from './fix-geo-location-country-ids';

// State ids and names are the legacy geo CSV rows (a04f80ed^). City rows are trimmed to a few per
// state_code group; stateId is the corrupted legacy value (El Salvador's Cuscatlán Department).
const WRONG_STATE_ID = 1146;

const states: GeoState[] = [
  { id: 1146, name: 'Cuscatlán Department', countryCode: 'SV', isoCode: '' },
  { id: 438, name: 'Bumthang District', countryCode: 'BT', isoCode: '' },
  { id: 4030, name: 'Alicante', countryCode: 'ES', isoCode: '' },
  { id: 4037, name: 'Barcelona', countryCode: 'ES', isoCode: '' },
  { id: 4044, name: 'Castellón', countryCode: 'ES', isoCode: '' },
  { id: 4050, name: 'Girona', countryCode: 'ES', isoCode: '' },
  { id: 4078, name: 'Valencia', countryCode: 'ES', isoCode: '' },
  { id: 3266, name: 'Central Luzon', countryCode: 'PH', isoCode: '' },
  { id: 3336, name: 'Holy Cross', countryCode: 'PL', isoCode: '' }
];

let nextCityId = 1;
function group(countryCode: string, stateCode: string, names: string[]): GeoCity[] {
  return names.map((name) => ({ id: nextCityId++, name, stateId: WRONG_STATE_ID, stateCode, countryCode }));
}

const cities: GeoCity[] = [
  ...group('BT', '33', ['Jakar']),
  // Package state CT (Catalonia) has no DB state. "Alcoy" stands in for a homonym found only
  // under VC, which used to win the vote and move the whole group to Valencia.
  ...group('ES', 'GI', ['Girona', 'Figueres', 'Blanes', 'Alcoy']),
  ...group('ES', 'B', ['Barcelona', 'Badalona']),
  // All three groups' cities are VC (the whole Valencian Community) in the package, which DB
  // province "Valencia" matches by name, so all three vote for it.
  ...group('ES', 'V', ['Valencia', 'Gandia', 'Alicante']),
  ...group('ES', 'A', ['Alicante/Alacant', 'Elche', 'Benidorm']),
  ...group('ES', 'CS', ['Castellón de la Plana', 'Vinaròs', 'Benicarló']),
  ...group('ES', 'ZZ', ['Atlantis']),
  ...group('PH', '3', ['Abucay']),
  ...group('PL', 'SK', ['Kielce'])
];

const stateNameOf = (plan: ReturnType<typeof planCityStateRepair>, cityName: string): string => {
  const city = cities.find((c) => c.name === cityName);
  const stateId = plan.cityStateUpdates.get(city.id) ?? city.stateId;
  return states.find((s) => s.id === stateId).name;
};

describe('planCityStateRepair', () => {
  const plan = planCityStateRepair(states, cities);

  it('re-points a city to the state its legacy state_code names', () => {
    expect(stateNameOf(plan, 'Jakar')).toBe('Bumthang District');
  });

  it('matches a legacy state_code missing the package leading zero', () => {
    expect(stateNameOf(plan, 'Abucay')).toBe('Central Luzon');
  });

  it('matches states through the name aliases', () => {
    expect(stateNameOf(plan, 'Kielce')).toBe('Holy Cross');
    expect(plan.stateIsoBackfills.get(3336)).toBe('SK');
  });

  it('does not let a homonym vote move a group whose package state has no DB state', () => {
    for (const name of ['Girona', 'Figueres', 'Blanes', 'Alcoy']) {
      expect(stateNameOf(plan, name)).toBe('Girona');
    }
  });

  it('gives each DB state to at most one group, resolving contested groups by capital name', () => {
    expect(stateNameOf(plan, 'Gandia')).toBe('Valencia');
    expect(stateNameOf(plan, 'Elche')).toBe('Alicante');
    expect(stateNameOf(plan, 'Vinaròs')).toBe('Castellón');
    expect(stateNameOf(plan, 'Badalona')).toBe('Barcelona');
  });

  it('leaves cities it cannot resolve unchanged and reports them', () => {
    expect(plan.unresolvedCities.map((c) => c.name)).toEqual(['Atlantis']);
    expect(plan.cityStateUpdates.has(cities.find((c) => 'Atlantis' === c.name).id)).toBe(false);
  });

  it('changes nothing when run again on the repaired data', () => {
    const repairedStates = states.map((s) => ({ ...s, isoCode: plan.stateIsoBackfills.get(s.id) ?? s.isoCode }));
    const repairedCities = cities.map((c) => ({ ...c, stateId: plan.cityStateUpdates.get(c.id) ?? c.stateId }));
    const rerun = planCityStateRepair(repairedStates, repairedCities);

    expect(rerun.stateIsoBackfills.size).toBe(0);
    expect(rerun.cityStateUpdates.size).toBe(0);
  });
});
