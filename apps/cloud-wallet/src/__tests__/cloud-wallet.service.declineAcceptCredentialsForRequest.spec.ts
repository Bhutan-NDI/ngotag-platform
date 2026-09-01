/**
 * Regression tests for the 5 cloud-wallet endpoints that were stubbed as 501 (#71 review,
 * 329947e7) because agent-controller had no matching endpoint at the time. Restored/wired now
 * that agent-controller has real endpoints for all 5:
 *  - declineProofRequest / getCredentialsByProofId: restored — deleted, never had a bug of their
 *    own, agent-controller gained /didcomm/proofs/:id/decline-request and
 *    /didcomm/proofs/:id/credentials-for-request in PR #76.
 *  - submitProofWithCred / deleteCredentialByRecord / deleteW3cCredentialByRecord: new — agent-
 *    controller never had these before either (ported from legacy pipeline-implementation).
 *
 * Locks in the URL paths specifically, since the guardian-branch reference implementations these
 * were adapted from pointed at stale /multi-tenancy/* paths that agent-controller's current
 * contract doesn't have — the whole point of this fix is to hit the real /didcomm/* paths instead.
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
  commonService: { httpGet: jest.Mock; httpPost: jest.Mock; httpDelete: jest.Mock };
} {
  const commonService = {
    httpGet: jest.fn(async () => ({ data: 'get-response' })),
    httpPost: jest.fn(async () => ({ data: 'post-response' })),
    httpDelete: jest.fn(async () => ({ status: 200 })),
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

describe('CloudWalletService.declineProofRequest', () => {
  it('posts to the real /didcomm/proofs/:id/decline-request path with the tenant-scoped credential', async () => {
    const { service, commonService } = makeService();

    await service.declineProofRequest({
      proofRecordId: 'proof-1',
      userId: 'user-1',
      email: 'user@example.com',
      sendProblemReport: true,
      problemReportDescription: 'not needed'
    });

    expect(commonService.httpPost).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/proof-1${CommonConstants.CLOUD_WALLET_DECLINE_PROOF_REQUEST}`,
      { sendProblemReport: true, problemReportDescription: 'not needed' },
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });
});

describe('CloudWalletService.submitProofWithCred', () => {
  it('posts to the real /didcomm/proofs/:id/accept-request-with-cred path, not the stale /multi-tenancy one', async () => {
    const { service, commonService } = makeService();
    const proof = {
      proofRecordId: 'proof-1',
      comment: 'here',
      proofFormats: { presentationExchange: { credentials: { 'descriptor-1': 'cred-a' } } }
    };

    await service.submitProofWithCred({ userId: 'user-1', email: 'user@example.com', proof });

    expect(commonService.httpPost).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/proof-1${CommonConstants.CLOUD_WALLET_POST_PROOF_REQUEST_WITH_CRED}`,
      proof,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
    expect(
      `${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}${CommonConstants.CLOUD_WALLET_POST_PROOF_REQUEST_WITH_CRED}`
    ).not.toContain('multi-tenancy');
  });
});

describe('CloudWalletService.getCredentialsByProofId', () => {
  it('gets from the real /didcomm/proofs/:id/credentials-for-request path, not the stale /multi-tenancy one', async () => {
    const { service, commonService } = makeService();

    await service.getCredentialsByProofId({
      proofRecordId: 'proof-1',
      userId: 'user-1',
      email: 'user@example.com'
    });

    expect(commonService.httpGet).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.CLOUD_WALLET_GET_PROOF_REQUEST}/proof-1${CommonConstants.CLOUD_WALLET_GET_CREDENTIALS_BY_PROOF_REQUEST}`,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });
});

describe('CloudWalletService.deleteCredentialByRecord', () => {
  it('deletes at the real /didcomm/credentials/:id path, not the stale /multi-tenancy one', async () => {
    const { service, commonService } = makeService();

    await service.deleteCredentialByRecord({
      userId: 'user-1',
      email: 'user@example.com',
      credentialRecordId: 'cred-1'
    });

    expect(commonService.httpDelete).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.CLOUD_WALLET_CREDENTIAL}/cred-1`,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });
});

describe('CloudWalletService.deleteW3cCredentialByRecord', () => {
  it('deletes at the real /didcomm/credentials/w3c/:id path, not the stale /multi-tenancy one', async () => {
    const { service, commonService } = makeService();

    await service.deleteW3cCredentialByRecord({
      userId: 'user-1',
      email: 'user@example.com',
      credentialRecordId: 'cred-1'
    });

    expect(commonService.httpDelete).toHaveBeenCalledWith(
      `${AGENT_ENDPOINT}${CommonConstants.CLOUD_WALLET_W3C_CREDENTIAL}/cred-1`,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });
});
