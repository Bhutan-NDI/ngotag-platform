/**
 * Regression test — #71 review: createCloudWallet picked a base wallet via getAvailableBaseWallet
 * (a plain read: `useCount < maxSubWallets`) and only recorded the placement afterward, via a
 * separate, unconditional incrementBaseWalletUseCount call made *after* the remote tenant was
 * already created. Two concurrent requests could both read the same base wallet with room for
 * exactly one more tenant and both proceed, over-provisioning it past maxSubWallets -- a classic
 * read-then-write race, not an atomic claim.
 *
 * claimBaseWalletCapacity replaces that: the capacity check and the write happen as a single
 * `updateMany` with the check IN the WHERE clause, so Postgres's row lock makes "is there room"
 * and "take it" one atomic operation. Constructed directly (not via Nest's TestingModule/DI
 * container) — same pattern as decrementBaseWalletUseCount.spec.ts.
 */
import { CloudWalletRepository } from '../cloud-wallet.repository';

describe('CloudWalletRepository.claimBaseWalletCapacity', () => {
  it('claims capacity with an atomic conditional update, not a plain unconditional increment', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    // eslint-disable-next-line camelcase
    const prisma = { cloud_wallet_user_info: { updateMany } };
    const logger = { error: jest.fn() };
    const repository = new CloudWalletRepository(prisma as never, logger as never);

    const claimed = await repository.claimBaseWalletCapacity('base-wallet-1', 5);

    expect(claimed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'base-wallet-1', useCount: { lt: 5 } },
      data: { useCount: { increment: 1 } }
    });
  });

  it('reports the claim as lost when the row no longer has room — a concurrent caller already took the last slot', async () => {
    // updateMany's WHERE (useCount < maxSubWallets) no longer matches the row by the time this
    // statement runs, so it updates nothing -- count 0, not an error. This is the whole point:
    // a plain increment (the previous approach) would have succeeded here regardless.
    const updateMany = jest.fn(async () => ({ count: 0 }));
    // eslint-disable-next-line camelcase
    const prisma = { cloud_wallet_user_info: { updateMany } };
    const logger = { error: jest.fn() };
    const repository = new CloudWalletRepository(prisma as never, logger as never);

    const claimed = await repository.claimBaseWalletCapacity('base-wallet-1', 5);

    expect(claimed).toBe(false);
  });
});
