// The root jest config has no mapping for bare `apps/...` imports.
jest.mock(
  'apps/api-gateway/src/verification/enum/verification.enum',
  () => jest.requireActual('../../../../api-gateway/src/verification/enum/verification.enum'),
  { virtual: true }
);

import { VerificationService } from '../../verification.service';
import { ProofResponseCodeService } from '../proof-response-code.service';
import { ResponseCodeStatus } from '../response-code.interface';

const ORG_ID = 'org-1';
const THREAD_ID = 'thread-1';
const REDIRECT_URI = 'https://rp.example.com/return';
const INVITATION_URL = 'https://short.example/abc';
const DEEPLINK_DOMAIN = 'https://link.example.id?url=';

type OobResult = { invitationUrl: string; deepLinkURL?: string; returnUrl?: string };

function makeService(redirectUriAllowlist: string | null = REDIRECT_URI): {
  service: VerificationService;
  responseCodes: ProofResponseCodeService;
  natsSend: jest.Mock;
} {
  const verificationRepository = {
    getAgentEndPoint: jest.fn(async () => ({ agentEndPoint: 'https://agent.example', redirectUriAllowlist })),
    getOrganization: jest.fn(async () => ({ name: 'RP Org' })),
    storeProofPresentation: jest.fn(async () => ({ id: 'presentation-row' }))
  };
  const natsSend = jest.fn(async () => ({
    invitationUrl: INVITATION_URL,
    proofRecordThId: THREAD_ID,
    outOfBandRecord: { id: 'oob-1' }
  }));
  const responseCodes = new ProofResponseCodeService();
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
    responseCodes
  );
  return { service, responseCodes, natsSend };
}

function sendOob(service: VerificationService, redirectUri?: string, extra: object = {}): Promise<unknown> {
  return service.sendOutOfBandPresentationRequest(
    {
      type: 'indy',
      proofFormats: { indy: { attributes: [] } } as never,
      redirectUri,
      ...extra
    },
    { orgId: ORG_ID } as never
  );
}

function responseCodeFrom(returnUrl: string): string {
  return new URL(returnUrl).searchParams.get('response_code');
}

function setDeepLinkDomain(value: string | undefined): void {
  if (undefined === value) {
    delete process.env.DEEPLINK_DOMAIN;
  } else {
    process.env.DEEPLINK_DOMAIN = value;
  }
}

describe('VerificationService — DIDComm redirect / response_code', () => {
  const originalDeepLinkDomain = process.env.DEEPLINK_DOMAIN;
  beforeEach(() => setDeepLinkDomain(DEEPLINK_DOMAIN));
  afterAll(() => setDeepLinkDomain(originalDeepLinkDomain));

  it('returns a plain deepLinkURL and no returnUrl when no redirectUri is supplied', async () => {
    const { service } = makeService();

    const result = (await sendOob(service)) as OobResult;

    expect(result.deepLinkURL).toBe(`${DEEPLINK_DOMAIN}${INVITATION_URL}`);
    expect(result.returnUrl).toBeUndefined();
  });

  it('omits deepLinkURL without failing when DEEPLINK_DOMAIN is not configured', async () => {
    setDeepLinkDomain(undefined);
    const { service } = makeService();

    const result = (await sendOob(service, REDIRECT_URI)) as OobResult;

    expect(result.deepLinkURL).toBeUndefined();
    expect(result.returnUrl).toMatch(/^https:\/\/rp\.example\.com\/return\?response_code=[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a redirectUri the org has not registered, before creating an invitation', async () => {
    const { service, natsSend } = makeService();

    await expect(sendOob(service, 'https://evil.example.net/return')).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 })
    });
    expect(natsSend).not.toHaveBeenCalled();
  });

  it('fails closed when the org has no registered redirect URIs', async () => {
    const { service, natsSend } = makeService(null);

    await expect(sendOob(service, REDIRECT_URI)).rejects.toBeDefined();
    expect(natsSend).not.toHaveBeenCalled();
  });

  it('rejects redirectUri combined with emailId', async () => {
    const { service, natsSend } = makeService();

    await expect(sendOob(service, REDIRECT_URI, { emailId: ['a@example.com'] })).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 })
    });
    expect(natsSend).not.toHaveBeenCalled();
  });

  it('does not forward redirectUri to the agent', async () => {
    const { service, natsSend } = makeService();

    await sendOob(service, REDIRECT_URI);

    const [[, , agentPayload]] = natsSend.mock.calls;
    expect(agentPayload.proofRequestPayload).not.toHaveProperty('redirectUri');
  });

  it('runs the full flow: deeplink carries response_code -> pending -> webhook -> terminal read once -> expired', async () => {
    const { service } = makeService();

    const { deepLinkURL, returnUrl } = (await sendOob(service, REDIRECT_URI)) as OobResult;
    expect(returnUrl.startsWith(`${REDIRECT_URI}?response_code=`)).toBe(true);
    expect(deepLinkURL).toBe(`${DEEPLINK_DOMAIN}${INVITATION_URL}&returnUrl=${encodeURIComponent(returnUrl)}`);
    const responseCode = responseCodeFrom(returnUrl);
    expect(responseCode).toBeTruthy();

    expect(await service.getProofCallbackResult(responseCode)).toEqual({ status: ResponseCodeStatus.PENDING });
    // Polling while pending must not consume the token.
    expect(await service.getProofCallbackResult(responseCode)).toEqual({ status: ResponseCodeStatus.PENDING });

    await service.webhookProofPresentation({
      orgId: ORG_ID,
      proofPresentationPayload: {
        threadId: THREAD_ID,
        state: 'done',
        isVerified: true,
        presentationId: 'pres-1'
      } as never
    });

    expect(await service.getProofCallbackResult(responseCode)).toEqual({
      status: ResponseCodeStatus.VERIFIED,
      threadId: THREAD_ID,
      result: { state: 'done', isVerified: true, presentationId: 'pres-1', errorMessage: undefined }
    });
    expect(await service.getProofCallbackResult(responseCode)).toEqual({ status: ResponseCodeStatus.EXPIRED });
  });

  it('marks an abandoned proof as failed', async () => {
    const { service } = makeService();
    const { returnUrl } = (await sendOob(service, REDIRECT_URI)) as OobResult;

    await service.webhookProofPresentation({
      orgId: ORG_ID,
      proofPresentationPayload: { threadId: THREAD_ID, state: 'abandoned', isVerified: false } as never
    });

    expect((await service.getProofCallbackResult(responseCodeFrom(returnUrl))).status).toBe(ResponseCodeStatus.FAILED);
  });

  it('returns expired for an unknown or empty response_code', async () => {
    const { service } = makeService();

    expect(await service.getProofCallbackResult('does-not-exist')).toEqual({ status: ResponseCodeStatus.EXPIRED });
    expect(await service.getProofCallbackResult('')).toEqual({ status: ResponseCodeStatus.EXPIRED });
  });

  it('never fails the webhook when the session store throws', async () => {
    const { service, responseCodes } = makeService();
    jest.spyOn(responseCodes, 'markTerminalByThreadId').mockRejectedValue(new Error('redis down'));

    await expect(
      service.webhookProofPresentation({
        orgId: ORG_ID,
        proofPresentationPayload: { threadId: THREAD_ID, state: 'done', isVerified: true } as never
      })
    ).resolves.toEqual({ id: 'presentation-row' });
  });

  it('still returns the invitation (without redirect) when minting the session fails', async () => {
    const { service, responseCodes } = makeService();
    jest.spyOn(responseCodes, 'createSession').mockRejectedValue(new Error('boom'));

    const result = (await sendOob(service, REDIRECT_URI)) as OobResult;

    expect(result.invitationUrl).toBe(INVITATION_URL);
    expect(result.deepLinkURL).toBe(`${DEEPLINK_DOMAIN}${INVITATION_URL}`);
    expect(result.returnUrl).toBeUndefined();
  });
});
