/**
 * Regression test — #73 review: getCloudSubWallet used findFirstOrThrow, so a holder with no
 * cloud wallet (or one that was just deleted) raised a raw, unmapped PrismaClientKnownRequestError
 * (P2025) instead of returning null -- which is what every caller's own explicit
 * `if (!cloudSubWalletDetails) throw NotFoundException` guard expects to handle. Fixed by
 * switching the underlying Prisma call to findFirst.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) — PrismaService is trivial to
 * fake for this single method.
 */
import { CloudWalletType } from '@credebl/enum/enum';

import { CloudWalletRepository } from '../cloud-wallet.repository';

describe('CloudWalletRepository.getCloudSubWallet', () => {
  it('returns null, not a thrown Prisma error, when no matching sub-wallet exists', async () => {
    const findFirst = jest.fn(async () => null);
    // eslint-disable-next-line camelcase
    const prisma = { cloud_wallet_user_info: { findFirst } };
    const logger = { error: jest.fn() };
    const repository = new CloudWalletRepository(prisma as never, logger as never);

    const result = await repository.getCloudSubWallet('user-with-no-wallet');

    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-with-no-wallet', type: CloudWalletType.SUB_WALLET }
    });
  });

  it('still returns the matching sub-wallet when one exists', async () => {
    const record = { id: 'sub-wallet-1', userId: 'user-1', type: CloudWalletType.SUB_WALLET };
    const findFirst = jest.fn(async () => record);
    // eslint-disable-next-line camelcase
    const prisma = { cloud_wallet_user_info: { findFirst } };
    const logger = { error: jest.fn() };
    const repository = new CloudWalletRepository(prisma as never, logger as never);

    const result = await repository.getCloudSubWallet('user-1');

    expect(result).toBe(record);
  });
});
