/**
 * Regression tests locking in the URL built by getProofPresentation and getProofById -- both had
 * a stray trailing `}` appended after the interpolated path segment (fixed in this same PR).
 * getProofPresentation is confirmed live (the clientbox/agent-service bridge's CLOUDWALLET_GET_PROOFS
 * NATS call hits it directly); getProofById is unreached today (the bridge's "get proof by id" call
 * goes to the separate getProofFormatDataByProofRecordId instead) but carried the identical bug.
 *
 * Constructed directly (not via Nest's TestingModule/DI container), same convention as
 * cloud-wallet.service.getExportWalletStatus.spec.ts.
 */
import { CommonConstants } from '@credebl/common/common.constant';

import { CloudWalletService } from '../cloud-wallet.service';

const AGENT_ENDPOINT = 'https://agent.example.com';
const DECRYPTED_API_KEY = 'decrypted-tenant-key';

function makeService(): {
  service: CloudWalletService;
  commonService: { httpGet: jest.Mock };
} {
  const commonService = {
    httpGet: jest.fn(async () => ({ data: 'get-response' })),
    handleError: jest.fn(async (error: unknown) => {
      throw error;
    })
  };
  const cloudWalletRepository = {};
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const service = new CloudWalletService(commonService as never, cloudWalletRepository as never, logger as never);
  jest
    .spyOn(service as never, '_commonCloudWalletInfo')
    .mockResolvedValue([{ agentEndpoint: AGENT_ENDPOINT }, DECRYPTED_API_KEY] as never);
  return { service, commonService };
}

describe('CloudWalletService.getProofPresentation', () => {
  it('builds a clean URL with no threadId, no stray trailing character', async () => {
    const { service, commonService } = makeService();

    await service.getProofPresentation({ userId: 'user-1', email: 'user@example.com', threadId: '' });

    expect(commonService.httpGet).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/`,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });

  it('builds a clean URL with a threadId query param, no stray trailing character', async () => {
    const { service, commonService } = makeService();

    await service.getProofPresentation({ userId: 'user-1', email: 'user@example.com', threadId: 'thread-1' });

    expect(commonService.httpGet).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/?threadId=thread-1`,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });
});

describe('CloudWalletService.getProofById', () => {
  it('builds a clean URL for a given proofRecordId, no stray trailing character', async () => {
    const { service, commonService } = makeService();

    await service.getProofById({ userId: 'user-1', email: 'user@example.com', proofRecordId: 'proof-1' });

    expect(commonService.httpGet).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/proof-1`,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });
});
