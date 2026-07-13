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
    sessionLocalUserId?: string | null;
  }): BuiltService => {
    const repository = {
      getOnboardingSession: jest.fn().mockResolvedValue({
        id: sessionId,
        expiresAt: futureDate,
        // localUserId is what linkAccount binds after verifying the Marketplace purchaser;
        // default it to the calling user so the account-link guard passes unless overridden.
        subscription: {
          id: subscriptionInternalId,
          localUserId: overrides.sessionLocalUserId === undefined ? userId : overrides.sessionLocalUserId
        }
      }),
      getActiveSubscriptionByOrgId: jest.fn().mockResolvedValue(overrides.activeSubscription ?? null),
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

    // The occupancy check must exclude the current subscription so a pre-existing older
    // active row is still detected; the repository excludes Unsubscribed rows itself.
    expect(repository.getActiveSubscriptionByOrgId).toHaveBeenCalledWith(orgId, subscriptionInternalId);
    expect(repository.linkOrganization).toHaveBeenCalledWith(subscriptionInternalId, orgId);
    expect(result).toEqual({ orgId, nextAction: 'activate' });
  });

  it('rejects linking when the subscription is not yet account-linked to the caller', async () => {
    // A valid sessionId alone must not be enough: linkAccount has not bound this
    // subscription to the caller (localUserId differs), so org linking must fail before
    // any ownership lookup, occupancy check, or write happens.
    const { service, repository, organizationClient } = buildService({ sessionLocalUserId: 'someone-else' });

    await expect(service.linkOrganization(message)).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationClient.send).not.toHaveBeenCalled();
    expect(repository.getActiveSubscriptionByOrgId).not.toHaveBeenCalled();
    expect(repository.linkOrganization).not.toHaveBeenCalled();
  });

  it('rejects linking when the subscription has no linked account yet (localUserId null)', async () => {
    const { service, repository, organizationClient } = buildService({ sessionLocalUserId: null });

    await expect(service.linkOrganization(message)).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationClient.send).not.toHaveBeenCalled();
    expect(repository.linkOrganization).not.toHaveBeenCalled();
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

/**
 * The activation step records setup-fee billing, so it carries the same session-owner risk
 * as linkOrganization: a bare sessionId must not let a caller activate a subscription that
 * was not account-linked to them.
 */
describe('MarketplaceService.activateSubscription (session-owner guard)', () => {
  const sessionId = 'session-1';
  const orgId = '00000000-0000-0000-0000-000000000001';
  const userId = 'user-1';
  const subscriptionInternalId = 'sub-internal-1';
  const oneHourMs = 60 * 60 * 1000;
  const futureDate = new Date(Date.now() + oneHourMs);

  const buildService = (
    sessionLocalUserId: string | null
  ): { service: MarketplaceService; repository: Record<string, jest.Mock> } => {
    const repository = {
      getOnboardingSession: jest.fn().mockResolvedValue({
        id: sessionId,
        expiresAt: futureDate,
        subscription: {
          id: subscriptionInternalId,
          orgId,
          localUserId: sessionLocalUserId,
          saasSubscriptionStatus: 'Subscribed',
          marketplaceSubscriptionId: 'ms-sub-1',
          planId: 'business'
        }
      }),
      setActivationStatus: jest.fn().mockResolvedValue(undefined),
      updateOnboardingSession: jest.fn().mockResolvedValue(undefined)
    };

    const service = new MarketplaceService(
      { send: jest.fn() } as never,
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    return { service, repository };
  };

  it('rejects activation when the subscription is not account-linked to the caller', async () => {
    const { service, repository } = buildService('someone-else');

    await expect(service.activateSubscription({ sessionId, orgId, userId })).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.setActivationStatus).not.toHaveBeenCalled();
    expect(repository.updateOnboardingSession).not.toHaveBeenCalled();
  });
});
