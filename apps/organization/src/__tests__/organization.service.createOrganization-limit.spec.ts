/**
 * The platform-wide MAX_ORG_LIMIT (and a Marketplace plan's organisation limit) stop a user from
 * creating an organisation once they belong to that many. A platform admin isn't bound by either.
 *
 * The name check right after the limits is made to fail (the name already exists), so reaching it
 * means the request got past the limits.
 */
import { OrganizationService } from '../organization.service';
import { ResponseMessages } from '@credebl/common/response-messages';

const USER_ID = 'user-1';
const ORIGINAL_LIMIT = process.env.MAX_ORG_LIMIT;

function buildService(options: { platformAdmin: boolean; orgCount: number; planMax?: number | null }): {
  service: OrganizationService;
  organizationRepository: Record<string, jest.Mock>;
} {
  const organizationRepository = {
    isPlatformAdmin: jest.fn().mockResolvedValue(options.platformAdmin),
    userOrganizationCount: jest.fn().mockResolvedValue(options.orgCount),
    getMarketplaceMaxOrganizationsByUser: jest.fn().mockResolvedValue(options.planMax ?? null),
    checkOrganizationNameExist: jest.fn().mockResolvedValue({ id: 'existing-org' })
  };

  // Positional constructor args: only organizationRepository (4th) and logger (9th) are used.
  const service = new OrganizationService(
    {} as never,
    {} as never,
    {} as never,
    organizationRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );

  return { service, organizationRepository };
}

async function createError(service: OrganizationService): Promise<string> {
  try {
    await service.createOrganization({ name: 'Acme' } as never, USER_ID, 'keycloak-user-1');
  } catch (error) {
    return JSON.stringify(error);
  }
  throw new Error('expected createOrganization to throw');
}

describe('OrganizationService.createOrganization — organisation limits', () => {
  beforeAll(() => {
    process.env.MAX_ORG_LIMIT = '10';
  });

  afterAll(() => {
    process.env.MAX_ORG_LIMIT = ORIGINAL_LIMIT;
  });

  it('stops a user who already belongs to 10 organisations', async () => {
    const { service, organizationRepository } = buildService({ platformAdmin: false, orgCount: 10 });

    expect(await createError(service)).toContain(ResponseMessages.organisation.error.MaximumOrgsLimit);
    expect(organizationRepository.checkOrganizationNameExist).not.toHaveBeenCalled();
  });

  it('lets a user with fewer than 10 organisations past the limit', async () => {
    const { service, organizationRepository } = buildService({ platformAdmin: false, orgCount: 9 });

    await createError(service);

    expect(organizationRepository.checkOrganizationNameExist).toHaveBeenCalledWith('Acme');
  });

  it('lets a platform admin create more than 10 organisations', async () => {
    const { service, organizationRepository } = buildService({ platformAdmin: true, orgCount: 25 });

    expect(await createError(service)).not.toContain(ResponseMessages.organisation.error.MaximumOrgsLimit);
    expect(organizationRepository.isPlatformAdmin).toHaveBeenCalledWith(USER_ID);
    expect(organizationRepository.checkOrganizationNameExist).toHaveBeenCalledWith('Acme');
  });

  it('does not hold a platform admin to a Marketplace plan organisation limit either', async () => {
    const { service, organizationRepository } = buildService({ platformAdmin: true, orgCount: 3, planMax: 1 });

    expect(await createError(service)).not.toContain('marketplace_org_limit_reached');
    expect(organizationRepository.getMarketplaceMaxOrganizationsByUser).not.toHaveBeenCalled();
    expect(organizationRepository.checkOrganizationNameExist).toHaveBeenCalled();
  });

  it('still holds other users to a Marketplace plan limit', async () => {
    const { service } = buildService({ platformAdmin: false, orgCount: 1, planMax: 1 });

    expect(await createError(service)).toContain('marketplace_org_limit_reached');
  });
});
