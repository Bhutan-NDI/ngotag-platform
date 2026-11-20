import { REDIRECT_DEFAULT_EXPIRES_IN_SECONDS, VerificationService } from '../../verification.service';
import {
  DEFAULT_PENDING_TTL_SECONDS,
  ProofResponseCodeService,
  REQUEST_DEADLINE_GRACE_SECONDS
} from '../proof-response-code.service';
import { ResponseCodeStatus } from '../response-code.interface';
import { FakeRedis } from './fake-redis';
import { toTerminalResponseCodeStatus } from '../redirect-uri.util';

const ORG_ID = 'org-1';
const THREAD_ID = 'thread-1';
const REDIRECT_URI = 'https://rp.example.com/return';

function makeService(): { service: VerificationService; redis: FakeRedis; natsSend: jest.Mock } {
  const redis = new FakeRedis();
  const responseCodes = new ProofResponseCodeService();
  (responseCodes as unknown as { client: FakeRedis }).client = redis;
  const natsSend = jest.fn(async () => ({
    invitationUrl: 'https://short.example/abc',
    proofRecordThId: THREAD_ID,
    outOfBandRecord: { id: 'oob-1' }
  }));
  const service = new VerificationService(
    {} as never,
    {
      getAgentEndPoint: jest.fn(async () => ({
        agentEndPoint: 'https://agent.example',
        redirectUriAllowlist: REDIRECT_URI
      })),
      getOrganization: jest.fn(async () => ({ name: 'RP Org' })),
      storeProofPresentation: jest.fn(async () => ({ id: 'presentation-row' }))
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { send: natsSend } as never,
    {} as never,
    responseCodes
  );
  return { service, redis, natsSend };
}

async function sendOob(service: VerificationService, extra: object = {}): Promise<{ returnUrl?: string }> {
  return (await service.sendOutOfBandPresentationRequest(
    { type: 'indy', proofFormats: { indy: { attributes: [] } } as never, ...extra },
    { orgId: ORG_ID } as never
  )) as { returnUrl?: string };
}

function sessionTtl(redis: FakeRedis, returnUrl: string): number {
  const token = new URL(returnUrl).searchParams.get('response_code');
  return redis.ttls.get(`verification:response-code:${token}`);
}

function agentExpiresInSeconds(natsSend: jest.Mock): unknown {
  return natsSend.mock.calls[0][2].proofRequestPayload.expiresInSeconds;
}

describe('response_code session follows the proof request deadline', () => {
  it('lives as long as the requested expiry plus the grace period', async () => {
    const { service, redis, natsSend } = makeService();

    const { returnUrl } = await sendOob(service, { redirectUri: REDIRECT_URI, expiresInSeconds: 1800 });

    expect(agentExpiresInSeconds(natsSend)).toBe(1800);
    expect(sessionTtl(redis, returnUrl)).toBe(1800 + REQUEST_DEADLINE_GRACE_SECONDS);
  });

  it('gives a redirect request without an expiry the 600 s default, and sizes the session to it', async () => {
    const { service, redis, natsSend } = makeService();

    const { returnUrl } = await sendOob(service, { redirectUri: REDIRECT_URI });

    expect(agentExpiresInSeconds(natsSend)).toBe(REDIRECT_DEFAULT_EXPIRES_IN_SECONDS);
    expect(sessionTtl(redis, returnUrl)).toBe(REDIRECT_DEFAULT_EXPIRES_IN_SECONDS + REQUEST_DEADLINE_GRACE_SECONDS);
  });

  it('caps the redirect default at PROOF_REQUEST_EXPIRY_MAX_SECONDS', async () => {
    process.env.PROOF_REQUEST_EXPIRY_MAX_SECONDS = '400';
    try {
      const { service, redis, natsSend } = makeService();

      const { returnUrl } = await sendOob(service, { redirectUri: REDIRECT_URI });

      expect(agentExpiresInSeconds(natsSend)).toBe(400);
      expect(sessionTtl(redis, returnUrl)).toBe(400 + REQUEST_DEADLINE_GRACE_SECONDS);
    } finally {
      delete process.env.PROOF_REQUEST_EXPIRY_MAX_SECONDS;
    }
  });

  it('leaves the expiry to the agent default when there is no redirect', async () => {
    const { service, natsSend } = makeService();

    await sendOob(service);

    expect(agentExpiresInSeconds(natsSend)).toBeUndefined();
  });

  it('falls back to the configured pending TTL when no request lifetime is known', async () => {
    const redis = new FakeRedis();
    const responseCodes = new ProofResponseCodeService();
    (responseCodes as unknown as { client: FakeRedis }).client = redis;

    for (const lifetime of [undefined, 0, -5, 1.5]) {
      const token = await responseCodes.createSession(ORG_ID, `thread-${lifetime}`, REDIRECT_URI, lifetime);
      expect(redis.ttls.get(`verification:response-code:${token}`)).toBe(DEFAULT_PENDING_TTL_SECONDS);
    }
  });
});

describe('an expired request is reported as expired, not failed', () => {
  it('maps abandoned + request-expired to expired, and any other abandoned to failed', () => {
    expect(toTerminalResponseCodeStatus('abandoned', false, 'abandoned: request-expired')).toBe(
      ResponseCodeStatus.EXPIRED
    );
    expect(toTerminalResponseCodeStatus('abandoned', false, 'abandoned: Proof request declined')).toBe(
      ResponseCodeStatus.FAILED
    );
    expect(toTerminalResponseCodeStatus('abandoned', false, undefined)).toBe(ResponseCodeStatus.FAILED);
  });

  it('gives the relying party an expired result for the request, once', async () => {
    const { service } = makeService();
    const { returnUrl } = await sendOob(service, { redirectUri: REDIRECT_URI, expiresInSeconds: 300 });
    const responseCode = new URL(returnUrl).searchParams.get('response_code');

    await service.webhookProofPresentation({
      orgId: ORG_ID,
      proofPresentationPayload: {
        threadId: THREAD_ID,
        state: 'abandoned',
        isVerified: false,
        errorMessage: 'abandoned: request-expired'
      } as never
    });

    // The result names the thread, unlike the bare "expired" for an unknown or used code.
    expect(await service.getProofCallbackResult(responseCode)).toEqual({
      status: ResponseCodeStatus.EXPIRED,
      threadId: THREAD_ID,
      result: { state: 'abandoned', presentationId: undefined }
    });
    expect(await service.getProofCallbackResult(responseCode)).toEqual({ status: ResponseCodeStatus.EXPIRED });
  });
});
