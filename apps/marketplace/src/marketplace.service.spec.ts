import { ConflictException, ForbiddenException } from '@nestjs/common';
import { MarketplaceService } from './marketplace.service';
import { of } from 'rxjs';

// BaseService is imported via a bare 'libs/...' path that jest's moduleNameMapper does not
// resolve; stub it virtually so the real MarketplaceService can be loaded in isolation.
// (ts-jest hoists jest.mock above the imports, so this applies before the service loads.)
jest.mock(
  'libs/service/base.service',
  () => ({
    BaseService: class {
      protected logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    }
  }),
  { virtual: true }
);

interface BuiltService {
  service: MarketplaceService;
  repository: Record<string, jest.Mock>;
  organizationClient: { send: jest.Mock };
}

/**
 * Focused unit tests for MarketplaceService.linkOrganization on the link_existing path,
 * covering the activation-blocked fix (reuse an existing org) and its ownership guard.
 */
describe('MarketplaceService.linkOrganization (link_existing)', () => {
  const sessionId = 'session-1';
  const orgId = '00000000-0000-0000-0000-000000000001';
  const userId = 'user-1';
  const subscriptionInternalId = 'sub-internal-1';

  const oneHourMs = 60 * 60 * 1000;
  const futureDate = new Date(Date.now() + oneHourMs);

  const buildService = (overrides: {
    owner?: unknown;
    activeSubscription?: unknown;
  }): BuiltService => {
    const repository = {
      getOnboardingSession: jest.fn().mockResolvedValue({
        id: sessionId,
        expiresAt: futureDate,
        subscription: { id: subscriptionInternalId }
      }),
      getActiveSubscriptionByOrgId: jest
        .fn()
        .mockResolvedValue(overrides.activeSubscription ?? null),
      linkOrganization: jest.fn().mockResolvedValue(undefined),
      updateOnboardingSession: jest.fn().mockResolvedValue(undefined)
    };

    const organizationClient = {
      send: jest.fn().mockReturnValue(
        of(
          overrides.owner ?? {
            userOrgRoles: [{ user: { id: userId } }]
          }
        )
      )
    };

    const service = new MarketplaceService(
      organizationClient as never,
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    return { service, repository, organizationClient };
  };

  const message = {
    sessionId,
    payload: { mode: 'link_existing' as const, orgId },
    user: { id: userId }
  };

  it('re-links the org when no active subscription occupies it (prior Unsubscribed)', async () => {
    const { service, repository } = buildService({ activeSubscription: null });

    const result = await service.linkOrganization(message);

    expect(repository.linkOrganization).toHaveBeenCalledWith(subscriptionInternalId, orgId);
    expect(result).toEqual({ orgId, nextAction: 'activate' });
  });

  it('blocks when another live subscription already occupies the org', async () => {
    const { service, repository } = buildService({
      activeSubscription: { id: 'other-subscription' }
    });

    await expect(service.linkOrganization(message)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.linkOrganization).not.toHaveBeenCalled();
  });

  it('forbids linking an organization the user does not own', async () => {
    const { service, repository } = buildService({
      owner: { userOrgRoles: [{ user: { id: 'someone-else' } }] }
    });

    await expect(service.linkOrganization(message)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.getActiveSubscriptionByOrgId).not.toHaveBeenCalled();
    expect(repository.linkOrganization).not.toHaveBeenCalled();
  });
});
