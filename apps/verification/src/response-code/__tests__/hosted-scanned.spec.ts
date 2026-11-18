import { VerificationService } from '../../verification.service';
import { ProofResponseCodeService, REQUEST_DEADLINE_GRACE_SECONDS } from '../proof-response-code.service';
import { FakeRedis } from './fake-redis';

const ORG_ID = 'org-1';
const THREAD_ID = 'thread-1';
const OOB_ID = 'oob-1';
const REDIRECT_URI = 'https://rp.example.com/return';

type OobResult = { returnUrl?: string; hostedPageUrl?: string };

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
        invitationUrl: 'https://short.example/abc',
        proofRecordThId: THREAD_ID,
        outOfBandRecord: { id: OOB_ID }
      }))
    } as never,
    {} as never,
    responseCodes
  );
}

async function hostedRequest(
  service: VerificationService,
  extra: object = {}
): Promise<{ hostedId: string; returnUrl: string }> {
  const result = (await service.sendOutOfBandPresentationRequest(
    { type: 'indy', proofFormats: { indy: { attributes: [] } } as never, redirectUri: REDIRECT_URI, ...extra },
    { orgId: ORG_ID } as never
  )) as OobResult;
  return { hostedId: result.hostedPageUrl.split('/v/')[1], returnUrl: result.returnUrl };
}

describe('hosted page: scanned (DL-016)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.HOSTED_PAGE_BASE_URL = 'https://id.bhutanndi.com';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('reports scanned once the wallet connects for the invitation', async () => {
    const service = makeService();
    const { hostedId } = await hostedRequest(service);

    await service.markHostedScanned(OOB_ID, ORG_ID);

    expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'scanned' });
  });

  it('ignores a scan reported for another org or an invitation without a hosted page', async () => {
    const service = makeService();
    const { hostedId } = await hostedRequest(service);

    await service.markHostedScanned(OOB_ID, 'other-org');
    await service.markHostedScanned('unknown-oob', ORG_ID);
    await service.markHostedScanned(undefined, ORG_ID);

    expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'pending' });
  });

  it('moves on from scanned to the outcome, and a late scan does not change it', async () => {
    const service = makeService();
    const { hostedId, returnUrl } = await hostedRequest(service);
    await service.markHostedScanned(OOB_ID, ORG_ID);

    await service.webhookProofPresentation({
      orgId: ORG_ID,
      proofPresentationPayload: { threadId: THREAD_ID, state: 'done', isVerified: true } as never
    });
    await service.markHostedScanned(OOB_ID, ORG_ID);

    expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'completed', returnUrl });
  });

  it('reports expired when a scanned request is not approved before the deadline', async () => {
    const service = makeService();
    const { hostedId } = await hostedRequest(service, { expiresInSeconds: 300 });
    await service.markHostedScanned(OOB_ID, ORG_ID);
    const now = Date.now();
    // Still scanned through the grace period, in case the approval lands then; expired after it.
    jest.spyOn(Date, 'now').mockReturnValue(now + 301_000);
    expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'scanned' });

    const afterGraceMs = (300 + REQUEST_DEADLINE_GRACE_SECONDS + 1) * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(now + afterGraceMs);
    expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'expired' });
  });

  it('completes every flow without the signal: pending straight to the outcome', async () => {
    const service = makeService();
    const { hostedId, returnUrl } = await hostedRequest(service);

    expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'pending' });
    await service.webhookProofPresentation({
      orgId: ORG_ID,
      proofPresentationPayload: { threadId: THREAD_ID, state: 'done', isVerified: true } as never
    });

    expect(await service.getHostedStatus(hostedId)).toEqual({ status: 'completed', returnUrl });
  });

  it('does not recreate a hosted session that expired before the scan was recorded', async () => {
    const service = makeService();
    const { hostedId } = await hostedRequest(service);
    const redis = (
      (service as unknown as { proofResponseCodeService: ProofResponseCodeService })
        .proofResponseCodeService as unknown as {
        client: FakeRedis;
      }
    ).client;
    const responseCodes = (service as unknown as { proofResponseCodeService: ProofResponseCodeService })
      .proofResponseCodeService;
    const read = jest.spyOn(responseCodes, 'getHostedSession');
    read.mockImplementationOnce(async (id) => {
      const session = JSON.parse(redis.store.get(`verification:hosted:${id}`));
      redis.store.delete(`verification:hosted:${id}`);
      return session;
    });

    expect(await responseCodes.markHostedScanned(OOB_ID, ORG_ID)).toBe(false);
    expect(redis.store.has(`verification:hosted:${hostedId}`)).toBe(false);
  });

  it('never fails when the session store is down', async () => {
    const service = makeService();
    await hostedRequest(service);
    const redis = (
      (service as unknown as { proofResponseCodeService: ProofResponseCodeService })
        .proofResponseCodeService as unknown as {
        client: FakeRedis;
      }
    ).client;
    redis.connected = false;

    await expect(service.markHostedScanned(OOB_ID, ORG_ID)).resolves.toBeUndefined();
  });
});
