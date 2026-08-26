/**
 * Regression tests — #73 review, two findings on CloudWalletService.deleteCloudWallet:
 *
 *   1. useCount was only ever incremented (createCloudWallet), never decremented on delete --
 *      after maxSubWallets cumulative creations, getAvailableBaseWallet's useCount < maxSubWallets
 *      filter permanently excludes the base wallet even if every sub-wallet has since been
 *      deleted. Fixed with a new decrementBaseWalletUseCount, called (best-effort, mirroring
 *      createCloudWallet's own increment) once the tenant + row are actually gone.
 *   2. getCloudSubWallet used findFirstOrThrow, so a holder with no cloud wallet (or one that was
 *      just deleted) raised a raw, unmapped PrismaClientKnownRequestError that reached the gateway
 *      as an opaque 500 instead of the NotFoundException this method's own guard exists to
 *      produce. Fixed by switching the repository method to findFirst.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) — same pattern as
 * getExportWalletStatus.spec.ts.
 */
import { NotFoundException } from '@nestjs/common';

import { CloudWalletService } from '../cloud-wallet.service';

const AGENT_ENDPOINT = 'https://agent.example.com';
const TENANT_ID = 'tenant-under-test';
const BASE_WALLET_ID = 'base-wallet-1';
const SUB_WALLET_ID = 'sub-wallet-1';

function makeService(cloudSubWalletDetails: unknown): {
  service: CloudWalletService;
  cloudWalletRepository: {
    getCloudSubWallet: jest.Mock;
    getBaseWalletByAgentEndpoint: jest.Mock;
    deleteCloudWalletDetails: jest.Mock;
    decrementBaseWalletUseCount: jest.Mock;
  };
  commonService: { httpDelete: jest.Mock };
} {
  const commonService = {
    httpDelete: jest.fn(async () => ({ status: 200 })),
    decryptPassword: jest.fn(async () => 'decrypted-base-wallet-key'),
    handleError: jest.fn(async (error: unknown) => {
      throw error;
    })
  };
  const cloudWalletRepository = {
    getCloudSubWallet: jest.fn(async () => cloudSubWalletDetails),
    getBaseWalletByAgentEndpoint: jest.fn(async () => ({ id: BASE_WALLET_ID, agentEndpoint: AGENT_ENDPOINT })),
    deleteCloudWalletDetails: jest.fn(async () => ({ id: SUB_WALLET_ID })),
    decrementBaseWalletUseCount: jest.fn(async () => undefined)
  };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const service = new CloudWalletService(commonService as never, cloudWalletRepository as never, logger as never);
  return { service, cloudWalletRepository, commonService };
}

describe('CloudWalletService.deleteCloudWallet', () => {
  it('decrements the base wallet useCount once the tenant and row are actually deleted', async () => {
    const { service, cloudWalletRepository } = makeService({
      id: SUB_WALLET_ID,
      tenantId: TENANT_ID,
      agentEndpoint: AGENT_ENDPOINT
    });

    await service.deleteCloudWallet({ userId: 'user-1' } as never);

    expect(cloudWalletRepository.decrementBaseWalletUseCount).toHaveBeenCalledWith(BASE_WALLET_ID);
  });

  it('still returns the deleted record even if the decrement itself fails — a counter update must not undo an already-successful delete', async () => {
    const { service, cloudWalletRepository } = makeService({
      id: SUB_WALLET_ID,
      tenantId: TENANT_ID,
      agentEndpoint: AGENT_ENDPOINT
    });
    cloudWalletRepository.decrementBaseWalletUseCount.mockRejectedValue(new Error('simulated DB error'));

    const result = await service.deleteCloudWallet({ userId: 'user-1' } as never);

    expect(result).toEqual({ id: SUB_WALLET_ID });
  });

  it('reports a clean NotFoundException, not a raw Prisma error, when the holder has no cloud wallet', async () => {
    // getCloudSubWallet now returns null (findFirst) rather than throwing (findFirstOrThrow) when
    // nothing matches -- this method's own existing guard is what turns that into the intended 404.
    const { service } = makeService(null);

    await expect(service.deleteCloudWallet({ userId: 'user-1' } as never)).rejects.toThrow(NotFoundException);
  });
});
