import { RpcException } from '@nestjs/microservices';
import { VerificationService } from '../../verification.service';
import { ProofResponseCodeService } from '../proof-response-code.service';
import { FakeRedis } from './fake-redis';

const ORG_ID = 'org-1';
const THREAD_ID = 'thread-1';
const REDIRECT_URI = 'https://rp.example.com/return';
const OOB_URL = 'https://agent.example/didcomm?oob=eyJAdHlwZSI6Im9vYiJ9';
const SHORT_URL = 'https://bucket.s3.example/abc';
const GATEWAY = 'https://api.example.com';
const DEEPLINK_DOMAIN = 'bhutanndi://data?url=';

type OobResult = { invitationUrl: string; deepLinkURL?: string; returnUrl?: string; hostedPageUrl?: string };

function makeService(): VerificationService {
  const responseCodes = new ProofResponseCodeService();
  (responseCodes as unknown as { client: FakeRedis }).client = new FakeRedis();
  return new VerificationService(
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
        invitationUrl: OOB_URL,
        proofRecordThId: THREAD_ID,
        outOfBandRecord: { id: 'oob-1' }
      }))
    } as never,
    {} as never,
    responseCodes
  );
}

async function hostedRequest(service: VerificationService, extra: object = {}): Promise<OobResult> {
  return (await service.sendOutOfBandPresentationRequest(
    { type: 'indy', proofFormats: { indy: { attributes: [] } } as never, redirectUri: REDIRECT_URI, ...extra },
    { orgId: ORG_ID } as never
  )) as OobResult;
}

function hostedIdOf(result: OobResult): string {
  return result.hostedPageUrl.split('/v/')[1];
}

function scanTokenOf(proofRequestURL: string): string {
  return proofRequestURL.split('/verification/hosted/i/')[1];
}

describe('hosted page: scan link (supersedes the DL-016 signal source)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.HOSTED_PAGE_BASE_URL = 'https://id.bhutanndi.com';
    process.env.HOSTED_SCAN_BASE_URL = `${GATEWAY}/`;
    process.env.DEEPLINK_DOMAIN = DEEPLINK_DOMAIN;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('points the page QR code and deep link at the scan link, and leaves the relying party response as it was', async () => {
    const service = makeService();
    const result = await hostedRequest(service);

    const page = await service.getHostedPage(hostedIdOf(result));

    expect(page.proofRequestURL).toMatch(/^https:\/\/api\.example\.com\/verification\/hosted\/i\/[0-9a-f]{64}$/);
    expect(page.deepLinkURL).toBe(
      `${DEEPLINK_DOMAIN}${page.proofRequestURL}&returnUrl=${encodeURIComponent(result.returnUrl)}`
    );
    expect(result.invitationUrl).toBe(OOB_URL);
    expect(result.deepLinkURL).toBe(`${DEEPLINK_DOMAIN}${OOB_URL}&returnUrl=${encodeURIComponent(result.returnUrl)}`);
  });

  it('answers the full oob URL and marks the request scanned on a wallet fetch, for every fetch', async () => {
    const service = makeService();
    const result = await hostedRequest(service);
    const token = scanTokenOf((await service.getHostedPage(hostedIdOf(result))).proofRequestURL);

    expect(await service.getHostedStatus(hostedIdOf(result))).toEqual({ status: 'pending' });
    expect(await service.getHostedInvitation(token, true)).toBe(OOB_URL);
    expect(await service.getHostedStatus(hostedIdOf(result))).toEqual({ status: 'scanned' });
    // A rescan or the app's second fetch gets the same answer.
    expect(await service.getHostedInvitation(token, true)).toBe(OOB_URL);
  });

  it('serves the agent URL from before shortening', async () => {
    const service = makeService();
    jest.spyOn(service, 'storeVerificationObjectAndReturnUrl').mockResolvedValue(SHORT_URL);
    const result = await hostedRequest(service, { isShortenUrl: true });
    const token = scanTokenOf((await service.getHostedPage(hostedIdOf(result))).proofRequestURL);

    expect(result.invitationUrl).toBe(SHORT_URL);
    expect(await service.getHostedInvitation(token, true)).toBe(OOB_URL);
  });

  it('does not mark scanned for a fetch that is not the wallet, such as a link preview', async () => {
    const service = makeService();
    const result = await hostedRequest(service);
    const token = scanTokenOf((await service.getHostedPage(hostedIdOf(result))).proofRequestURL);

    expect(await service.getHostedInvitation(token, false)).toBe(OOB_URL);
    expect(await service.getHostedStatus(hostedIdOf(result))).toEqual({ status: 'pending' });
  });

  it('keeps the outcome when the link is fetched after the proof ended', async () => {
    const service = makeService();
    const result = await hostedRequest(service);
    const token = scanTokenOf((await service.getHostedPage(hostedIdOf(result))).proofRequestURL);
    await service.webhookProofPresentation({
      orgId: ORG_ID,
      proofPresentationPayload: { threadId: THREAD_ID, state: 'done', isVerified: true } as never
    });

    await service.getHostedInvitation(token, true);

    expect(await service.getHostedStatus(hostedIdOf(result))).toEqual({
      status: 'completed',
      returnUrl: result.returnUrl
    });
  });

  it('answers not found for an unknown token', async () => {
    const service = makeService();

    const error = await service.getHostedInvitation('a'.repeat(64), true).catch((e) => e);

    expect(error).toBeInstanceOf(RpcException);
    expect(((error as RpcException).getError() as { statusCode: number }).statusCode).toBe(404);
  });

  it('keeps the plain invitation on the page when HOSTED_SCAN_BASE_URL is not set', async () => {
    delete process.env.HOSTED_SCAN_BASE_URL;
    const service = makeService();
    const result = await hostedRequest(service);

    const page = await service.getHostedPage(hostedIdOf(result));

    expect(page.proofRequestURL).toBe(OOB_URL);
    expect(page.deepLinkURL).toBe(result.deepLinkURL);
  });
});
