/**
 * Regression tests — #71 review: createCloudWallet picked a base wallet via getAvailableBaseWallet
 * (a plain read) and only recorded the placement afterward, via an unconditional
 * incrementBaseWalletUseCount call made *after* the remote tenant was already created. Two
 * concurrent requests could both read the same base wallet with room for exactly one more tenant
 * and both proceed, over-provisioning it past maxSubWallets.
 *
 * Fixed by claiming capacity atomically (claimBaseWalletCapacity) immediately after the
 * availability read and before any remote call, failing the request with a Conflict if the claim
 * is lost to a concurrent caller, and releasing the claim (decrementBaseWalletUseCount) if
 * anything after that point fails — a request that claimed a slot but never actually used it must
 * not permanently burn it.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) — same pattern as
 * deleteCloudWallet.spec.ts.
 */
import { ConflictException } from '@nestjs/common';

import { CloudWalletService } from '../cloud-wallet.service';

const BASE_WALLET_ID = 'base-wallet-1';
const MAX_SUB_WALLETS = 5;
const AGENT_ENDPOINT = 'https://agent.example.com';

function makeService(overrides: { claimed?: boolean; httpPostImpl?: jest.Mock }): {
  service: CloudWalletService;
  cloudWalletRepository: {
    checkUserExist: jest.Mock;
    getAvailableBaseWallet: jest.Mock;
    claimBaseWalletCapacity: jest.Mock;
    decrementBaseWalletUseCount: jest.Mock;
    storeCloudWalletDetails: jest.Mock;
  };
  commonService: { httpPost: jest.Mock };
} {
  const commonService = {
    decryptPassword: jest.fn(async () => 'decrypted-base-wallet-key'),
    checkAgentHealth: jest.fn(async () => true),
    httpPost: overrides.httpPostImpl ?? jest.fn(async () => ({ id: 'tenant-1', token: 'wallet-token' })),
    dataEncryption: jest.fn((value: string) => `encrypted(${value})`),
    handleError: jest.fn(async (error: unknown) => {
      throw error;
    })
  };
  const cloudWalletRepository = {
    checkUserExist: jest.fn(async () => null),
    getAvailableBaseWallet: jest.fn(async () => ({
      id: BASE_WALLET_ID,
      agentEndpoint: AGENT_ENDPOINT,
      agentApiKey: 'encrypted-base-wallet-key',
      maxSubWallets: MAX_SUB_WALLETS
    })),
    claimBaseWalletCapacity: jest.fn(async () => overrides.claimed ?? true),
    decrementBaseWalletUseCount: jest.fn(async () => undefined),
    storeCloudWalletDetails: jest.fn(async () => ({ id: 'stored-sub-wallet-1' }))
  };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const service = new CloudWalletService(commonService as never, cloudWalletRepository as never, logger as never);
  return { service, cloudWalletRepository, commonService };
}

describe('CloudWalletService.createCloudWallet', () => {
  it('claims capacity atomically, passing the availability read’s own maxSubWallets, before making any remote call', async () => {
    const { service, cloudWalletRepository, commonService } = makeService({});

    await service.createCloudWallet({ label: 'my-wallet', userId: 'user-1' } as never);

    expect(cloudWalletRepository.claimBaseWalletCapacity).toHaveBeenCalledWith(BASE_WALLET_ID, MAX_SUB_WALLETS);
    // The claim must land before the remote tenant-creation call, not after -- otherwise a
    // request with no claimed capacity could still create a remote tenant.
    const [claimOrder] = cloudWalletRepository.claimBaseWalletCapacity.mock.invocationCallOrder;
    const [httpPostOrder] = commonService.httpPost.mock.invocationCallOrder;
    expect(claimOrder).toBeLessThan(httpPostOrder);
    expect(cloudWalletRepository.decrementBaseWalletUseCount).not.toHaveBeenCalled();
  });

  it('fails closed with a Conflict when the claim is lost to a concurrent caller, without ever calling the remote agent', async () => {
    const { service, cloudWalletRepository, commonService } = makeService({ claimed: false });

    await expect(service.createCloudWallet({ label: 'my-wallet', userId: 'user-1' } as never)).rejects.toThrow(
      ConflictException
    );

    expect(commonService.httpPost).not.toHaveBeenCalled();
    // Never claimed, so there is nothing to release.
    expect(cloudWalletRepository.decrementBaseWalletUseCount).not.toHaveBeenCalled();
  });

  it('releases the claimed slot when the remote tenant creation fails after the claim succeeded', async () => {
    const httpPostImpl = jest.fn(async () => {
      throw new Error('simulated agent createTenant failure');
    });
    const { service, cloudWalletRepository } = makeService({ httpPostImpl });

    await expect(service.createCloudWallet({ label: 'my-wallet', userId: 'user-1' } as never)).rejects.toThrow();

    expect(cloudWalletRepository.claimBaseWalletCapacity).toHaveBeenCalledWith(BASE_WALLET_ID, MAX_SUB_WALLETS);
    expect(cloudWalletRepository.decrementBaseWalletUseCount).toHaveBeenCalledWith(BASE_WALLET_ID);
  });

  it('does not attempt to release anything when the failure happens before a claim was ever made', async () => {
    const { service, cloudWalletRepository } = makeService({});
    cloudWalletRepository.checkUserExist.mockResolvedValue({ id: 'existing-sub-wallet' });

    await expect(service.createCloudWallet({ label: 'my-wallet', userId: 'user-1' } as never)).rejects.toThrow();

    expect(cloudWalletRepository.claimBaseWalletCapacity).not.toHaveBeenCalled();
    expect(cloudWalletRepository.decrementBaseWalletUseCount).not.toHaveBeenCalled();
  });

  it('still fails the request even if releasing a claimed slot itself fails — the real error is not hidden behind a counter-update failure', async () => {
    const httpPostImpl = jest.fn(async () => {
      throw new Error('simulated agent createTenant failure');
    });
    const { service, cloudWalletRepository } = makeService({ httpPostImpl });
    cloudWalletRepository.decrementBaseWalletUseCount.mockRejectedValue(new Error('simulated release failure'));

    await expect(service.createCloudWallet({ label: 'my-wallet', userId: 'user-1' } as never)).rejects.toThrow(
      /simulated agent createTenant failure/
    );
  });
});
