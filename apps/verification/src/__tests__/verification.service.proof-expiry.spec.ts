// The root jest config has no mapping for bare `apps/...` imports.
jest.mock(
  'apps/api-gateway/src/verification/enum/verification.enum',
  () => jest.requireActual('../../../api-gateway/src/verification/enum/verification.enum'),
  { virtual: true }
);

import { VerificationService } from '../verification.service';

const ORG_ID = 'org-1';

const presentationDefinition = {
  id: 'pd-1',
  name: 'Verify Foundational ID',
  // eslint-disable-next-line camelcase
  input_descriptors: [{ id: 'input_0', schema: [{ uri: 'https://schema.example/fid' }] }]
};

function makeService(): { service: VerificationService; natsSend: jest.Mock } {
  const verificationRepository = {
    getAgentEndPoint: jest.fn(async () => ({ agentEndPoint: 'https://agent.example' })),
    getOrganization: jest.fn(async () => ({ name: 'RP Org' }))
  };
  const natsSend = jest.fn(async () => ({
    invitationUrl: 'https://short.example/abc',
    proofRecordThId: 'thread-1',
    outOfBandRecord: { id: 'oob-1' }
  }));
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

function agentPayloadFor(natsSend: jest.Mock, cmd = 'agent-send-out-of-band-proof-request'): Record<string, unknown> {
  const [[, pattern, agentPayload]] = natsSend.mock.calls;
  expect(pattern).toEqual({ cmd });
  return agentPayload.proofRequestPayload;
}

describe('VerificationService — out-of-band proof request expiresInSeconds', () => {
  const cases = [
    { type: 'presentationExchange', body: { presentationDefinition } },
    { type: 'indy', body: { proofFormats: { indy: { attributes: [] } } } }
  ];

  describe.each(cases)('$type', ({ type, body }) => {
    it('forwards expiresInSeconds unchanged to agent-controller', async () => {
      const { service, natsSend } = makeService();

      await service.sendOutOfBandPresentationRequest(
        { type, ...body, expiresInSeconds: 600 } as never,
        {
          orgId: ORG_ID
        } as never
      );

      expect(agentPayloadFor(natsSend).expiresInSeconds).toBe(600);
    });

    it.each([undefined, null])(
      'leaves it out when it is %p, so agent-controller applies its default',
      async (value) => {
        const { service, natsSend } = makeService();

        await service.sendOutOfBandPresentationRequest(
          { type, ...body, expiresInSeconds: value } as never,
          {
            orgId: ORG_ID
          } as never
        );

        const payload = agentPayloadFor(natsSend);
        // Absent from the serialised payload sent over NATS and HTTP.
        expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('expiresInSeconds');
      }
    );
  });
});

describe('VerificationService — connection-based proof request expiresInSeconds', () => {
  const cases = [
    { type: 'presentationExchange', body: { presentationDefinition } },
    { type: 'indy', body: { proofFormats: { indy: { attributes: [] } } } }
  ];

  function sendProofRequest(
    service: VerificationService,
    type: string,
    body: object,
    extra: object
  ): Promise<object | object[]> {
    return service.sendProofRequest({
      type,
      ...body,
      orgId: ORG_ID,
      version: 'neutral',
      connectionId: 'connection-1',
      comment: 'KYC',
      ...extra
    } as never);
  }

  describe.each(cases)('$type', ({ type, body }) => {
    it('forwards expiresInSeconds unchanged to agent-controller', async () => {
      const { service, natsSend } = makeService();

      await sendProofRequest(service, type, body, { expiresInSeconds: 600 });

      expect(agentPayloadFor(natsSend, 'agent-send-proof-request').expiresInSeconds).toBe(600);
    });

    it.each([undefined, null])(
      'leaves it out when it is %p, so agent-controller applies its default',
      async (value) => {
        const { service, natsSend } = makeService();

        await sendProofRequest(service, type, body, { expiresInSeconds: value });

        const payload = agentPayloadFor(natsSend, 'agent-send-proof-request');
        expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('expiresInSeconds');
      }
    );
  });
});
