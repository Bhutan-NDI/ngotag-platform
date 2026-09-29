// The root jest config has no mapping for bare `apps/...` imports.
jest.mock(
  'apps/api-gateway/src/verification/enum/verification.enum',
  () => jest.requireActual('../../../api-gateway/src/verification/enum/verification.enum'),
  { virtual: true }
);

import { VerificationService } from '../verification.service';

const ORG_ID = 'org-1';
const THREAD_ID = 'b1f0c2d4-0000-4000-8000-000000000001';
const PROOF_DATA = { request: { presentationExchange: {} }, presentation: { presentationExchange: {} } };

type Row = {
  threadId: string;
  orgId: string;
  state: string;
  isVerified: boolean;
  presentationId: string;
  connectionId?: string;
} | null;

function makeService(row: Row): { service: VerificationService; natsSend: jest.Mock } {
  const verificationRepository = {
    getPresentationByThreadId: jest.fn(async () => row),
    getAgentEndPoint: jest.fn(async () => ({ agentEndPoint: 'https://agent.example' }))
  };
  const natsSend = jest.fn(async () => PROOF_DATA);
  const service = new VerificationService(
    {} as never,
    verificationRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { send: natsSend } as never,
    {} as never,
    {} as never
  );
  return { service, natsSend };
}

const verifiedRow = {
  threadId: THREAD_ID,
  orgId: ORG_ID,
  state: 'done',
  isVerified: true,
  presentationId: 'proof-record-1',
  connectionId: 'conn-1'
};

describe('VerificationService.getProofPresentationByThreadId', () => {
  it('returns the raw proof data fetched live from the agent for a verified proof of this org', async () => {
    const { service, natsSend } = makeService(verifiedRow);

    await expect(service.getProofPresentationByThreadId(ORG_ID, THREAD_ID)).resolves.toEqual({
      threadId: THREAD_ID,
      presentationId: 'proof-record-1',
      connectionId: 'conn-1',
      state: 'done',
      isVerified: true,
      proofData: PROOF_DATA
    });
    const [[, pattern, payload]] = natsSend.mock.calls;
    expect(pattern).toEqual({ cmd: 'get-agent-verified-proof-details' });
    expect(payload).toEqual({ orgId: ORG_ID, url: expect.stringContaining('proof-record-1') });
  });

  it('returns 404 for an unknown thread ID', async () => {
    const { service, natsSend } = makeService(null);

    await expect(service.getProofPresentationByThreadId(ORG_ID, THREAD_ID)).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 404 })
    });
    expect(natsSend).not.toHaveBeenCalled();
  });

  it('returns 404, not the data, for a proof of another organization', async () => {
    const { service, natsSend } = makeService({ ...verifiedRow, orgId: 'other-org' });

    await expect(service.getProofPresentationByThreadId(ORG_ID, THREAD_ID)).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 404 })
    });
    expect(natsSend).not.toHaveBeenCalled();
  });

  it.each([
    ['still in progress', { state: 'request-sent', isVerified: null }],
    ['done but not verified', { state: 'done', isVerified: false }],
    ['declined', { state: 'declined', isVerified: false }],
    ['abandoned', { state: 'abandoned', isVerified: null }]
  ])('returns 409 without calling the agent when the proof is %s', async (_label, change) => {
    const { service, natsSend } = makeService({ ...verifiedRow, ...change } as Row);

    await expect(service.getProofPresentationByThreadId(ORG_ID, THREAD_ID)).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 409 })
    });
    expect(natsSend).not.toHaveBeenCalled();
  });
});
