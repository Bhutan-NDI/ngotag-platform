export interface CountryInterface {
  id: number;
  name: string;
  isoCode: string;
  phonecode?: string;
}

export interface StateInterface {
  id: number;
  name: string;
  isoCode: string;
  countryId: number;
  countryCode: string;
}

export interface CityInterface {
  id: number;
  name: string;
  stateId: number;
  stateCode: string;
  countryId: number;
  countryCode: string;
}
