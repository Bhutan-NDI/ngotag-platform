import { MarketplaceSubscriptionStatus } from '@prisma/client';
import { MarketplaceRepository } from './marketplace.repository';

/**
 * Repository-level tests for getActiveSubscriptionByOrgId — the query the
 * activation-blocked fix relies on. These assert the actual Prisma `where` clause so the
 * regression this PR fixes (a cancelled/Unsubscribed prior subscription must NOT block
 * re-linking, while any other live subscription must) is covered at the query layer rather
 * than only through a service mock that hard-codes the repository's return value.
 */
describe('MarketplaceRepository.getActiveSubscriptionByOrgId', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const currentSubscriptionId = 'sub-internal-1';

  const buildRepository = (findFirstResult: unknown): { repository: MarketplaceRepository; findFirst: jest.Mock } => {
    const findFirst = jest.fn().mockResolvedValue(findFirstResult);
    // marketplace_subscription is the Prisma model accessor, which cannot be camelCased.
    // eslint-disable-next-line camelcase
    const prisma = { marketplace_subscription: { findFirst } };
    const repository = new MarketplaceRepository(prisma as never);
    return { repository, findFirst };
  };

  it('excludes Unsubscribed rows and the current subscription from the occupancy check', async () => {
    const { repository, findFirst } = buildRepository(null);

    await repository.getActiveSubscriptionByOrgId(orgId, currentSubscriptionId);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        orgId,
        deletedAt: null,
        saasSubscriptionStatus: { not: MarketplaceSubscriptionStatus.Unsubscribed },
        id: { not: currentSubscriptionId }
      },
      orderBy: { createDateTime: 'desc' }
    });
  });

  it('returns null when only a cancelled (Unsubscribed) subscription exists for the org', async () => {
    // The Unsubscribed row is filtered out by the `where` clause, so Prisma yields null and
    // the buyer can re-link the same org to a fresh subscription.
    const { repository, findFirst } = buildRepository(null);

    const result = await repository.getActiveSubscriptionByOrgId(orgId, currentSubscriptionId);

    expect(result).toBeNull();
    expect(findFirst.mock.calls[0][0].where.saasSubscriptionStatus).toEqual({
      not: MarketplaceSubscriptionStatus.Unsubscribed
    });
  });

  it('returns a still-live subscription that occupies the org', async () => {
    const liveRow = { id: 'other-subscription', saasSubscriptionStatus: MarketplaceSubscriptionStatus.Subscribed };
    const { repository } = buildRepository(liveRow);

    const result = await repository.getActiveSubscriptionByOrgId(orgId, currentSubscriptionId);

    expect(result).toBe(liveRow);
  });

  it('omits the id filter when no current subscription is provided', async () => {
    const { repository, findFirst } = buildRepository(null);

    await repository.getActiveSubscriptionByOrgId(orgId);

    expect(findFirst.mock.calls[0][0].where).not.toHaveProperty('id');
  });
});
