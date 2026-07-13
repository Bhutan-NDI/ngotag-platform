import { CityInterface, CountryInterface, StateInterface } from '@credebl/common/interfaces/geolocation.interface';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@credebl/prisma-service';

@Injectable()
export class GeoLocationRepository {
  constructor(private readonly prisma: PrismaService) {}
  private readonly logger = new Logger('GeoLocationRepository');

  /**
   * Returns all countries sorted alphabetically.
   * IDs are the DB autoincrement values assigned during seeding
   * (seeded in alphabetical order, so ID 1 = first country alphabetically).
   */
  async findAllCountries(): Promise<CountryInterface[]> {
    try {
      return this.prisma.countries.findMany({
        select: {
          id: true,
          name: true,
          isoCode: true,
          phonecode: true
        },
        orderBy: { name: 'asc' }
      });
    } catch (error) {
      this.logger.error(`Error in GeoLocationRepository::[findAllCountries]: ${error}`);
      throw error;
    }
  }

  /**
   * Returns all states for a given countryId, sorted alphabetically.
   */
  async findStatesByCountryId(countryId: number): Promise<StateInterface[]> {
    try {
      return this.prisma.states.findMany({
        where: { countryId: Number(countryId) },
        select: {
          id: true,
          name: true,
          isoCode: true,
          countryId: true,
          countryCode: true
        },
        orderBy: { name: 'asc' }
      });
    } catch (error) {
      this.logger.error(`Error in GeoLocationRepository::[findStatesByCountryId]: ${error}`);
      throw error;
    }
  }

  /**
   * Returns all cities for a given stateId + countryId, sorted alphabetically.
   */
  async findCitiesByStateAndCountry(countryId: number, stateId: number): Promise<CityInterface[]> {
    try {
      return this.prisma.cities.findMany({
        where: {
          stateId: Number(stateId),
          countryId: Number(countryId)
        },
        select: {
          id: true,
          name: true,
          stateId: true,
          stateCode: true,
          countryId: true,
          countryCode: true
        },
        orderBy: { name: 'asc' }
      });
    } catch (error) {
      this.logger.error(`Error finding cities for stateId ${stateId} and countryId ${countryId}: ${error}`);
      throw error;
    }
  }
}
