/**
 * A delete that failed part-way must be retryable. Uses the real CommonService (only its HTTP client
 * is faked) so the "tenant already deleted" check is exercised against the errors it really throws.
 */
import { CommonService } from '@credebl/common';

import { CloudWalletService } from '../cloud-wallet.service';

const AGENT_ENDPOINT = 'https://agent.example.com';
const TENANT_ID = 'tenant-under-test';
const BASE_WALLET_ID = 'base-wallet-1';
const SUB_WALLET_ID = 'sub-wallet-1';

type AxiosLikeError = Error & { response?: { status: number; data?: unknown } };

function axiosError(message: string, response?: { status: number; data?: unknown }): AxiosLikeError {
  return Object.assign(new Error(message), { response });
}

interface Harness {
  service: CloudWalletService;
  cloudWalletRepository: {
    deleteCloudWalletDetails: jest.Mock;
    decrementBaseWalletUseCount: jest.Mock;
  };
}

function makeService(options: { subWallet?: unknown; agentError?: AxiosLikeError }): Harness {
  const httpService = {
    delete: jest.fn(() => ({
      toPromise: async (): Promise<unknown> => {
        if (options.agentError) {
          throw options.agentError;
        }
        return { status: 200 };
      }
    }))
  };
  const commonService = new CommonService(httpService as never);
  jest.spyOn(commonService, 'decryptPassword').mockResolvedValue('decrypted-base-wallet-key');

  const cloudWalletRepository = {
    getCloudSubWallet: jest.fn(async () => options.subWallet),
    getBaseWalletByAgentEndpoint: jest.fn(async () => ({ id: BASE_WALLET_ID, agentEndpoint: AGENT_ENDPOINT })),
    deleteCloudWalletDetails: jest.fn(async () => ({ id: SUB_WALLET_ID })),
    decrementBaseWalletUseCount: jest.fn(async () => undefined)
  };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const service = new CloudWalletService(commonService, cloudWalletRepository as never, logger as never);
  return { service, cloudWalletRepository };
}

const SUB_WALLET = { id: SUB_WALLET_ID, tenantId: TENANT_ID, agentEndpoint: AGENT_ENDPOINT };

describe('CloudWalletService.deleteCloudWallet — retry safety', () => {
  it('finishes the cleanup when the agent says the tenant is already gone', async () => {
    const agentError = axiosError('Request failed with status code 404', {
      status: 404,
      data: { reason: `Tenant with id: ${TENANT_ID} not found.` }
    });
    const { service, cloudWalletRepository } = makeService({ subWallet: SUB_WALLET, agentError });

    const result = await service.deleteCloudWallet({ userId: 'user-1', deleteHolder: true });

    expect(result).toEqual({ id: SUB_WALLET_ID });
    expect(cloudWalletRepository.deleteCloudWalletDetails).toHaveBeenCalledWith(SUB_WALLET_ID);
    expect(cloudWalletRepository.decrementBaseWalletUseCount).toHaveBeenCalledWith(BASE_WALLET_ID);
  });

  it('does not treat an unreachable agent (also mapped to a 404) as a deleted tenant', async () => {
    const agentError = axiosError('connect ECONNREFUSED 10.0.0.1:443', { status: 404, data: undefined });
    const { service, cloudWalletRepository } = makeService({ subWallet: SUB_WALLET, agentError });

    await expect(service.deleteCloudWallet({ userId: 'user-1', deleteHolder: true })).rejects.toBeDefined();

    expect(cloudWalletRepository.deleteCloudWalletDetails).not.toHaveBeenCalled();
    expect(cloudWalletRepository.decrementBaseWalletUseCount).not.toHaveBeenCalled();
  });

  it('does not treat a 404 without a tenant-not-found body (for example a wrong route) as a deleted tenant', async () => {
    const agentError = axiosError('Request failed with status code 404', { status: 404, data: 'Cannot DELETE' });
    const { service, cloudWalletRepository } = makeService({ subWallet: SUB_WALLET, agentError });

    await expect(service.deleteCloudWallet({ userId: 'user-1', deleteHolder: true })).rejects.toBeDefined();

    expect(cloudWalletRepository.deleteCloudWalletDetails).not.toHaveBeenCalled();
  });

  it('keeps failing on any other agent error, leaving the row in place', async () => {
    const agentError = axiosError('Request failed with status code 500', { status: 500, data: { message: 'boom' } });
    const { service, cloudWalletRepository } = makeService({ subWallet: SUB_WALLET, agentError });

    await expect(service.deleteCloudWallet({ userId: 'user-1', deleteHolder: true })).rejects.toBeDefined();

    expect(cloudWalletRepository.deleteCloudWalletDetails).not.toHaveBeenCalled();
  });

  it('returns null, without calling the agent, when the wallet is already gone and the holder is being deleted', async () => {
    const { service, cloudWalletRepository } = makeService({ subWallet: null });

    const result = await service.deleteCloudWallet({ userId: 'user-1', deleteHolder: true });

    expect(result).toBeNull();
    expect(cloudWalletRepository.deleteCloudWalletDetails).not.toHaveBeenCalled();
  });

  it('still reports a 404 for a missing wallet when the holder is not being deleted', async () => {
    const { service } = makeService({ subWallet: null });

    await expect(service.deleteCloudWallet({ userId: 'user-1', deleteHolder: false })).rejects.toMatchObject({
      error: { statusCode: 404 }
    });
  });
});
