/**
 * Regression test — #73 review: getImportWalletStatus interpolated the caller-supplied jobId
 * straight into a URL called with the base wallet's own (privileged) credential, with no
 * validation of the expected opaque format -- the same finding already fixed on the export side
 * (see getExportWalletStatus.spec.ts) had not been mirrored here. Fixed the same way: the
 * controller now runs jobId through ParseUUIDPipe before this service method is ever reached (see
 * CloudWalletController#getImportWalletStatus), and this service additionally applies
 * encodeURIComponent as defense in depth, in case that validation is ever loosened, bypassed, or
 * reached via an internal NATS caller directly.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) -- same pattern as the export
 * spec this mirrors.
 */
import { CommonConstants } from '@credebl/common/common.constant';

import { CloudWalletService } from '../cloud-wallet.service';

const AGENT_ENDPOINT = 'https://agent.example.com';
const TENANT_ID = 'tenant-under-test';

function makeService(): {
  service: CloudWalletService;
  commonService: { httpGet: jest.Mock };
} {
  const commonService = {
    httpGet: jest.fn(async () => ({ status: 'completed' })),
    decryptPassword: jest.fn(async () => 'decrypted-base-wallet-key'),
    handleError: jest.fn(async (error: unknown) => {
      throw error;
    })
  };
  const cloudWalletRepository = {
    getCloudSubWallet: jest.fn(async () => ({ tenantId: TENANT_ID }))
  };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const service = new CloudWalletService(commonService as never, cloudWalletRepository as never, logger as never);
  jest
    .spyOn(service as never, '_commonCloudWalletInfo')
    .mockResolvedValue([{ agentEndpoint: AGENT_ENDPOINT, agentApiKey: 'encrypted-base-wallet-key' }] as never);
  return { service, commonService };
}

describe('CloudWalletService.getImportWalletStatus — jobId is encoded before it reaches the agent URL', () => {
  it('URL-encodes a jobId containing characters that would otherwise change the request path', async () => {
    const { service, commonService } = makeService();
    // Realistically this can't reach here at all once ParseUUIDPipe is applied at the controller
    // layer -- this models the defense-in-depth layer on its own, independent of that pipe.
    const dangerousJobId = '../../agent/wallet';

    await service.getImportWalletStatus({ userId: 'user-1', email: 'user@example.com', jobId: dangerousJobId });

    const calledUrl = commonService.httpGet.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('/../');
    expect(calledUrl).toContain(encodeURIComponent(dangerousJobId));
  });

  it('still builds the expected URL for an ordinary jobId', async () => {
    const { service, commonService } = makeService();
    const jobId = 'a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789';

    await service.getImportWalletStatus({ userId: 'user-1', email: 'user@example.com', jobId });

    expect(commonService.httpGet).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.URL_CLOUD_WALLET_IMPORT}${TENANT_ID}/status/${jobId}`,
      expect.anything()
    );
  });
});
