/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
// The root jest config has no mapping for bare `apps/...` imports.
jest.mock(
  'apps/api-gateway/src/verification/enum/verification.enum',
  () => jest.requireActual('../../../api-gateway/src/verification/enum/verification.enum'),
  { virtual: true }
);

import { VerificationService } from '../verification.service';

type Privates = {
  generateOOBProofReq: (payload: { proofRequestPayload: Record<string, unknown> }) => Promise<unknown>;
};

const ORG_ID = 'org-verifier';
const USER = { orgId: ORG_ID } as never;

const build = (reuseDids: { invitationDid?: string; additionalInvitationDids?: string[] }) => {
  const repository = {
    getAgentEndPoint: jest.fn().mockResolvedValue({ agentEndPoint: 'https://agent.example.com' }),
    getOrganization: jest.fn().mockResolvedValue({ name: 'Verifier', logoUrl: undefined }),
    getReuseInvitationDids: jest.fn().mockResolvedValue(reuseDids)
  };
  const service = new VerificationService(
    {} as never,
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
  const generate = jest
    .spyOn(service as unknown as Privates, 'generateOOBProofReq')
    .mockResolvedValue({ invitationUrl: 'https://agent.example.com/oob', deepLinkURL: 'x' } as never);
  return { service, repository, generate };
};

const indyRequest = (extra: object = {}) => ({
  type: 'indy',
  reuseConnection: true,
  protocolVersion: 'v1',
  proofFormats: { indy: { name: 'proof', version: '1.0', requested_attributes: {}, requested_predicates: {} } },
  ...extra
});

const presentationExchangeRequest = (extra: object = {}) => ({
  type: 'presentationExchange',
  reuseConnection: true,
  protocolVersion: 'v2',
  presentationDefinition: { id: 'd1', name: 'n', input_descriptors: [] },
  ...extra
});

describe('out-of-band proof requests that reuse a connection', () => {
  it.each([
    ['an indy request', indyRequest],
    ['a presentation exchange request', presentationExchangeRequest]
  ])('carry the new invitation DID first and the old one second for an org that moved (%s)', async (_name, request) => {
    const { service, generate, repository } = build({
      invitationDid: 'did:peer:new',
      additionalInvitationDids: ['did:peer:old']
    });

    await service.sendOutOfBandPresentationRequest(request() as never, USER);

    expect(repository.getReuseInvitationDids).toHaveBeenCalledWith(ORG_ID);
    expect(generate.mock.calls[0][0].proofRequestPayload).toMatchObject({
      invitationDid: 'did:peer:new',
      additionalInvitationDids: ['did:peer:old']
    });
  });

  it.each([
    ['an indy request', indyRequest],
    ['a presentation exchange request', presentationExchangeRequest]
  ])(
    'carry just the invitation DID, and no additionalInvitationDids key, for any other org (%s)',
    async (_name, request) => {
      const { service, generate } = build({ invitationDid: 'did:peer:oldest' });

      await service.sendOutOfBandPresentationRequest(request() as never, USER);

      const [[{ proofRequestPayload }]] = generate.mock.calls;
      expect(proofRequestPayload).toMatchObject({ invitationDid: 'did:peer:oldest' });
      expect(proofRequestPayload).not.toHaveProperty('additionalInvitationDids');
    }
  );

  it.each([
    ['an indy request', indyRequest],
    ['a presentation exchange request', presentationExchangeRequest]
  ])('look up nothing when the request does not reuse a connection (%s)', async (_name, request) => {
    const { service, generate, repository } = build({ invitationDid: 'did:peer:oldest' });

    await service.sendOutOfBandPresentationRequest(request({ reuseConnection: false }) as never, USER);

    expect(repository.getReuseInvitationDids).not.toHaveBeenCalled();
    const [[{ proofRequestPayload }]] = generate.mock.calls;
    expect(proofRequestPayload.invitationDid).toBeUndefined();
    expect(proofRequestPayload).not.toHaveProperty('additionalInvitationDids');
  });
});
