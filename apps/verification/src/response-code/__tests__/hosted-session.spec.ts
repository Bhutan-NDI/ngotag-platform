import { RpcException } from '@nestjs/microservices';
import { VerificationService } from '../../verification.service';
import { ProofResponseCodeService, REQUEST_DEADLINE_GRACE_SECONDS } from '../proof-response-code.service';
import { ResponseCodeStatus } from '../response-code.interface';
import { FakeRedis } from './fake-redis';

const ORG_ID = 'org-1';
const THREAD_ID = 'thread-1';
const REDIRECT_URI = 'https://rp.example.com/return';
const INVITATION_URL = 'https://short.example/abc';
const BASE_URL = 'https://id.bhutanndi.com';

type OobResult = { invitationUrl: string; deepLinkURL?: string; returnUrl?: string; hostedPageUrl?: string };

function makeService(): { service: VerificationService; redis: FakeRedis } {
  const redis = new FakeRedis();
  const responseCodes = new ProofResponseCodeService();
  (responseCodes as unknown as { client: FakeRedis }).client = redis;
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
    {
      send: jest.fn(async () => ({
        invitationUrl: INVITATION_URL,
        proofRecordThId: THREAD_ID,
        outOfBandRecord: { id: 'oob-1' }
      }))
    } as never,
    {} as never,
    responseCodes
  );
  return { service, redis };
}

async function sendOob(service: VerificationService, extra: object = {}): Promise<OobResult> {
  return (await service.sendOutOfBandPresentationRequest(
    { type: 'indy', proofFormats: { indy: { attributes: [] } } as never, ...extra },
    { orgId: ORG_ID } as never
  )) as OobResult;
}

function hostedIdOf(result: OobResult): string {
  return result.hostedPageUrl.split('/v/')[1];
}

function codeOf(returnUrl: string): string {
  return new URL(returnUrl).searchParams.get('response_code');
}

async function webhook(service: VerificationService, payload: object): Promise<void> {
  await service.webhookProofPresentation({
    orgId: ORG_ID,
    proofPresentationPayload: { threadId: THREAD_ID, ...payload } as never
  });
}

function rpcStatus(error: unknown): number {
  return ((error as RpcException).getError() as { statusCode: number }).statusCode;
}

describe('hosted verification session', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.HOSTED_PAGE_BASE_URL = `${BASE_URL}/`;
    process.env.DEEPLINK_DOMAIN = 'https://link.example.id?url=';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('creation', () => {
    it('returns hostedPageUrl for a redirect request, living one grace period longer than the response_code session', async () => {
      const { service, redis } = makeService();

      const result = await sendOob(service, { redirectUri: REDIRECT_URI, expiresInSeconds: 900 });

      expect(result.hostedPageUrl).toMatch(/^https:\/\/id\.bhutanndi\.com\/v\/[A-Za-z0-9_-]{43}$/);
      const hostedId = hostedIdOf(result);
      const ttl = 900 + REQUEST_DEADLINE_GRACE_SECONDS;
      expect(redis.ttls.get(`verification:hosted:${hostedId}`)).toBe(ttl + REQUEST_DEADLINE_GRACE_SECONDS);
      expect(redis.ttls.get(`verification:response-code:${codeOf(result.returnUrl)}`)).toBe(ttl);
    });

    it('does not create a hosted page without a redirectUri', async () => {
      const { service } = makeService();

      expect((await sendOob(service)).hostedPageUrl).toBeUndefined();
    });

    it('keeps the plain redirect flow when HOSTED_PAGE_BASE_URL is not set', async () => {
      delete process.env.HOSTED_PAGE_BASE_URL;
      const { service } = makeService();

      const result = await sendOob(service, { redirectUri: REDIRECT_URI });

      expect(result.hostedPageUrl).toBeUndefined();
      expect(result.returnUrl).toContain('response_code=');
    });
  });

  describe('GET /verification/hosted/:hostedId', () => {
    it('returns what the page shows: the bare invitation for the QR, the code only in the deep link', async () => {
      const { service } = makeService();
      const before = Date.now();
      const result = await sendOob(service, { redirectUri: REDIRECT_URI, expiresInSeconds: 900 });

      const page = await service.getHostedPage(hostedIdOf(result));

      expect(page).toMatchObject({
        returnHost: 'rp.example.com',
        redirectUri: REDIRECT_URI,
        proofRequestURL: INVITATION_URL
      });
      // The page gets the relying party's deep link, with returnUrl, so the wallet returns the citizen (E7, DL-007).
      expect(result.deepLinkURL).toContain('returnUrl=');
      expect(page.deepLinkURL).toBe(result.deepLinkURL);
      // Everywhere else the code stays out: "Start again" uses redirectUri, and the QR the bare invitation (DL-004, DL-013).
      const withoutDeepLink = { ...page, deepLinkURL: undefined };
      expect(JSON.stringify(withoutDeepLink)).not.toContain('response_code');
      expect(JSON.stringify(withoutDeepLink)).not.toContain(codeOf(result.returnUrl));
      expect(page.proofRequestURL).not.toContain('returnUrl');
      const expiresAt = Date.parse(page.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 900_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    });

    it('answers not found for an unknown id', async () => {
      const { service } = makeService();

      await expect(service.getHostedPage('x'.repeat(43))).rejects.toBeInstanceOf(RpcException);
      expect(rpcStatus(await service.getHostedPage('x'.repeat(43)).catch((error) => error))).toBe(404);
    });
  });

  describe('GET /verification/hosted/:hostedId/status', () => {
    it('is pending, then completed with returnUrl, without consuming the code', async () => {
      const { service } = makeService();
      const result = await sendOob(service, { redirectUri: REDIRECT_URI });
      const hostedId = hostedIdOf(result);

      expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'pending' });

      await webhook(service, { state: 'done', isVerified: true, presentationId: 'pres-1' });
      expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'completed', returnUrl: result.returnUrl });

      // The relying party can still exchange the code after the page read the status.
      const exchanged = await service.getProofCallbackResult(codeOf(result.returnUrl));
      expect(exchanged.status).toBe(ResponseCodeStatus.COMPLETED);

      // Once the code is used, the page still learns the outcome, with nothing left to return.
      expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'completed' });
    });

    it('reports failed and declined with returnUrl, and an expired request as expired without one', async () => {
      const failed = makeService();
      const failedResult = await sendOob(failed.service, { redirectUri: REDIRECT_URI });
      await webhook(failed.service, { state: 'done', isVerified: false });
      expect(await failed.service.getHostedStatus(hostedIdOf(failedResult))).toEqual({
        status: 'failed',
        returnUrl: failedResult.returnUrl
      });

      const declined = makeService();
      const declinedResult = await sendOob(declined.service, { redirectUri: REDIRECT_URI });
      await webhook(declined.service, {
        state: 'abandoned',
        isVerified: false,
        errorMessage: 'abandoned: Request declined'
      });
      expect(await declined.service.getHostedStatus(hostedIdOf(declinedResult))).toEqual({
        status: 'declined',
        returnUrl: declinedResult.returnUrl
      });
      // TC-HVP-03 / DL-020: the exchange reports failed with reason declined; the page still learns it was declined.
      expect(await declined.service.getProofCallbackResult(codeOf(declinedResult.returnUrl))).toMatchObject({
        status: ResponseCodeStatus.FAILED,
        reason: 'declined'
      });
      expect(await declined.service.getHostedStatus(hostedIdOf(declinedResult))).toEqual({ status: 'declined' });

      const expired = makeService();
      const expiredResult = await sendOob(expired.service, { redirectUri: REDIRECT_URI });
      await webhook(expired.service, {
        state: 'abandoned',
        isVerified: false,
        errorMessage: 'abandoned: request-expired'
      });
      expect(await expired.service.getHostedStatus(hostedIdOf(expiredResult))).toEqual({ status: 'expired' });
    });

    it('reports expired once the deadline and grace period pass, even if the wallet never reported anything', async () => {
      const { service } = makeService();
      const result = await sendOob(service, { redirectUri: REDIRECT_URI, expiresInSeconds: 300 });
      const now = Date.now();
      const afterGraceMs = (300 + REQUEST_DEADLINE_GRACE_SECONDS + 1) * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(now + afterGraceMs);

      expect(await service.getHostedStatus(hostedIdOf(result))).toEqual({ status: 'expired' });
    });

    it('stays pending through the grace period, so a result landing then is completed, never expired first', async () => {
      const { service } = makeService();
      const result = await sendOob(service, { redirectUri: REDIRECT_URI, expiresInSeconds: 300 });
      const hostedId = hostedIdOf(result);
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 301_000);

      expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'pending' });

      await webhook(service, { state: 'done', isVerified: true, presentationId: 'pres-1' });
      expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'completed', returnUrl: result.returnUrl });
    });

    it('limits status reads per hostedId', async () => {
      process.env.HOSTED_STATUS_RATE_LIMIT_PER_MINUTE = '3';
      const { service, redis } = makeService();
      const hostedId = hostedIdOf(await sendOob(service, { redirectUri: REDIRECT_URI }));

      for (let i = 0; 3 > i; i++) {
        await service.getHostedStatus(hostedId);
      }
      expect(rpcStatus(await service.getHostedStatus(hostedId).catch((error) => error))).toBe(429);
      expect(redis.ttls.get(`verification:rate:hosted:${hostedId}`)).toBe(60);
    });
  });

  describe('store', () => {
    it('does not recreate a hosted session that expired between reading it and recording the outcome', async () => {
      const { service, redis } = makeService();
      const hostedId = hostedIdOf(await sendOob(service, { redirectUri: REDIRECT_URI }));
      const responseCodes = (service as unknown as { proofResponseCodeService: ProofResponseCodeService })
        .proofResponseCodeService;
      const session = await responseCodes.getHostedSession(hostedId);
      jest.spyOn(responseCodes, 'getHostedSession').mockResolvedValue(session);
      redis.store.delete(`verification:hosted:${hostedId}`);

      await responseCodes.recordHostedOutcome(THREAD_ID, ResponseCodeStatus.COMPLETED);

      expect(redis.store.has(`verification:hosted:${hostedId}`)).toBe(false);
    });

    it('sets the read counter and its window together, and keeps the window on later reads', async () => {
      const { service, redis } = makeService();
      const hostedId = hostedIdOf(await sendOob(service, { redirectUri: REDIRECT_URI }));
      const responseCodes = (service as unknown as { proofResponseCodeService: ProofResponseCodeService })
        .proofResponseCodeService;
      const key = `verification:rate:hosted:${hostedId}`;

      expect(await responseCodes.countHostedStatusRead(hostedId)).toBe(1);
      expect(redis.ttls.get(key)).toBe(60);
      redis.ttls.set(key, 12);
      expect(await responseCodes.countHostedStatusRead(hostedId)).toBe(2);
      expect(redis.ttls.get(key)).toBe(12);
    });
  });
});
