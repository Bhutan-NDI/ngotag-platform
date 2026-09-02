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
 * Asserts against literal expected path strings, not CommonConstants members read back out of the
 * production code under test -- a test built from `${CommonConstants.X}` on both sides of the
 * comparison can't detect a reverted/stale constant value (#85 review).
 *
 * Constructed directly (not via Nest's TestingModule/DI container), same convention as
 * cloud-wallet.service.getExportWalletStatus.spec.ts.
 */
import { HttpStatus } from '@nestjs/common';

import { CloudWalletService } from '../cloud-wallet.service';

const AGENT_ENDPOINT = 'https://agent.example.com';
const DECRYPTED_API_KEY = 'decrypted-tenant-key';

function makeService(): {
  service: CloudWalletService;
  commonService: { httpGet: jest.Mock; httpPost: jest.Mock; httpDelete: jest.Mock; handleError: jest.Mock };
} {
  const commonService = {
    httpGet: jest.fn(async () => ({ data: 'get-response' })),
    httpPost: jest.fn(async () => ({ data: 'post-response' })),
    httpDelete: jest.fn(async () => ({ data: { message: 'Credential Deleted Successfully' }, status: 204 })),
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
      `${AGENT_ENDPOINT}/didcomm/proofs/proof-1/decline-request/`,
      { sendProblemReport: true, problemReportDescription: 'not needed' },
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });

  it("maps agent-controller's invalid-state error to a 400, not a generic 500", async () => {
    const { service, commonService } = makeService();
    commonService.httpPost.mockRejectedValueOnce({
      response: { error: { message: "Proof record is in invalid state 'done'" } }
    });

    await expect(
      service.declineProofRequest({
        proofRecordId: 'proof-1',
        userId: 'user-1',
        email: 'user@example.com'
      })
    ).rejects.toMatchObject({ error: { statusCode: HttpStatus.BAD_REQUEST } });
    expect(commonService.handleError).not.toHaveBeenCalled();
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
      `${AGENT_ENDPOINT}/didcomm/proofs/proof-1/accept-request-with-cred`,
      proof,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });

  it("maps agent-controller's invalid-state error to a 400, not a generic 500", async () => {
    const { service, commonService } = makeService();
    commonService.httpPost.mockRejectedValueOnce({
      response: { error: { message: "Proof record is in invalid state 'done'" } }
    });

    await expect(
      service.submitProofWithCred({
        userId: 'user-1',
        email: 'user@example.com',
        proof: { proofRecordId: 'proof-1', proofFormats: { presentationExchange: { credentials: {} } } }
      })
    ).rejects.toMatchObject({ error: { statusCode: HttpStatus.BAD_REQUEST } });
    expect(commonService.handleError).not.toHaveBeenCalled();
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
      `${AGENT_ENDPOINT}/didcomm/proofs/proof-1/credentials-for-request`,
      { headers: { authorization: DECRYPTED_API_KEY } }
    );
  });

  it("maps agent-controller's invalid-state error to a 400, not a generic 500", async () => {
    const { service, commonService } = makeService();
    commonService.httpGet.mockRejectedValueOnce({
      response: { error: { message: "Proof record is in invalid state 'done'" } }
    });

    await expect(
      service.getCredentialsByProofId({
        proofRecordId: 'proof-1',
        userId: 'user-1',
        email: 'user@example.com'
      })
    ).rejects.toMatchObject({ error: { statusCode: HttpStatus.BAD_REQUEST } });
    expect(commonService.handleError).not.toHaveBeenCalled();
  });
});

describe('CloudWalletService.deleteCredentialByRecord', () => {
  it('deletes at the real /didcomm/credentials/:id path, not the stale /multi-tenancy one, returning just the body', async () => {
    const { service, commonService } = makeService();

    const result = await service.deleteCredentialByRecord({
      userId: 'user-1',
      email: 'user@example.com',
      credentialRecordId: 'cred-1'
    });

    expect(commonService.httpDelete).toHaveBeenCalledWith(`${AGENT_ENDPOINT}/didcomm/credentials/cred-1`, {
      headers: { authorization: DECRYPTED_API_KEY }
    });
    // Not the raw AxiosResponse -- returning that unchanged would either leak
    // .config.headers.authorization (the tenant's decrypted agent API key) to the calling client,
    // or throw on its circular request/socket references during NATS's JSON serialization. #85 review.
    expect(result).toEqual({ message: 'Credential Deleted Successfully' });
  });
});

describe('CloudWalletService.deleteW3cCredentialByRecord', () => {
  it('deletes at the real /didcomm/credentials/w3c/:id path, not the stale /multi-tenancy one, returning just the body', async () => {
    const { service, commonService } = makeService();

    const result = await service.deleteW3cCredentialByRecord({
      userId: 'user-1',
      email: 'user@example.com',
      credentialRecordId: 'cred-1'
    });

    expect(commonService.httpDelete).toHaveBeenCalledWith(`${AGENT_ENDPOINT}/didcomm/credentials/w3c/cred-1`, {
      headers: { authorization: DECRYPTED_API_KEY }
    });
    expect(result).toEqual({ message: 'Credential Deleted Successfully' });
  });
});
