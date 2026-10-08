/**
 * Regression test — #71 review: decrementBaseWalletUseCount used a plain `update` with
 * `{ decrement: 1 }`, with no floor at zero. Any base wallet configured before this migration
 * already had real tenants at useCount = 0 (the column's default); deleting those drove useCount
 * negative, which then made the `useCount < maxSubWallets` capacity filter accept far more
 * placements than the cap allows -- the opposite of what it's for. Fixed by guarding the decrement
 * with `useCount: { gt: 0 }` via `updateMany`, so a wallet already at zero is left alone.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) — PrismaService is trivial to
 * fake for this single method.
 */
import { CloudWalletRepository } from '../cloud-wallet.repository';

describe('CloudWalletRepository.decrementBaseWalletUseCount', () => {
  it('decrements only when useCount is above zero', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    // eslint-disable-next-line camelcase
    const prisma = { cloud_wallet_user_info: { updateMany } };
    const logger = { error: jest.fn() };
    const repository = new CloudWalletRepository(prisma as never, logger as never);

    await repository.decrementBaseWalletUseCount('base-wallet-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'base-wallet-1', useCount: { gt: 0 } },
      data: { useCount: { decrement: 1 } }
    });
  });

  it('does not throw when the wallet is already at zero — updateMany just matches nothing', async () => {
    const updateMany = jest.fn(async () => ({ count: 0 }));
    // eslint-disable-next-line camelcase
    const prisma = { cloud_wallet_user_info: { updateMany } };
    const logger = { error: jest.fn() };
    const repository = new CloudWalletRepository(prisma as never, logger as never);

    await expect(repository.decrementBaseWalletUseCount('base-wallet-1')).resolves.not.toThrow();
  });
});
