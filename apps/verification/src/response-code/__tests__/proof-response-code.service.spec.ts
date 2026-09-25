import {
  DEFAULT_PENDING_TTL_SECONDS,
  ProofResponseCodeService,
  RESULT_READY_TTL_SECONDS,
  resolvePendingTtlSeconds
} from '../proof-response-code.service';
import { ResponseCodeStatus } from '../response-code.interface';
import { FakeRedis } from './fake-redis';

const REDIRECT_URI = 'https://rp.example.com/return';
const VERIFIED = { state: 'done', isVerified: true, presentationId: 'pres-1' };
const FAILED = { state: 'abandoned', isVerified: false };

function makeService(redis = new FakeRedis()): { service: ProofResponseCodeService; redis: FakeRedis } {
  const service = new ProofResponseCodeService();
  (service as unknown as { client: FakeRedis }).client = redis;
  return { service, redis };
}

describe('ProofResponseCodeService', () => {
  it('mints an opaque 256-bit token and stores the session and thread index with the pending TTL', async () => {
    const { service, redis } = makeService();

    const token = await service.createSession('org-1', 'thread-1', REDIRECT_URI);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redis.store.get('verification:idx:thread:thread-1')).toBe(token);
    expect(redis.ttls.get(`verification:response-code:${token}`)).toBe(DEFAULT_PENDING_TTL_SECONDS);
    expect(redis.ttls.get('verification:idx:thread:thread-1')).toBe(DEFAULT_PENDING_TTL_SECONDS);
    expect(await service.getSession(token)).toMatchObject({
      orgId: 'org-1',
      threadId: 'thread-1',
      status: ResponseCodeStatus.PENDING
    });
  });

  it('moves a pending session to terminal and shortens both TTLs', async () => {
    const { service, redis } = makeService();
    const token = await service.createSession('org-1', 'thread-1', REDIRECT_URI);

    await service.markTerminalByThreadId('thread-1', ResponseCodeStatus.VERIFIED, VERIFIED);

    expect(await service.getSession(token)).toMatchObject({ status: ResponseCodeStatus.VERIFIED, result: VERIFIED });
    expect(redis.ttls.get(`verification:response-code:${token}`)).toBe(RESULT_READY_TTL_SECONDS);
    expect(redis.ttls.get('verification:idx:thread:thread-1')).toBe(RESULT_READY_TTL_SECONDS);
  });

  it('is a no-op for a proof that has no session', async () => {
    const { service, redis } = makeService();

    await service.markTerminalByThreadId('unknown-thread', ResponseCodeStatus.FAILED, FAILED);

    expect(redis.store.size).toBe(0);
  });

  it('keeps the first terminal result and its TTL when a second terminal webhook arrives', async () => {
    const { service, redis } = makeService();
    const token = await service.createSession('org-1', 'thread-1', REDIRECT_URI);
    await service.markTerminalByThreadId('thread-1', ResponseCodeStatus.VERIFIED, VERIFIED);
    redis.ttls.set(`verification:response-code:${token}`, 5);

    await service.markTerminalByThreadId('thread-1', ResponseCodeStatus.FAILED, FAILED);

    expect(await service.getSession(token)).toMatchObject({ status: ResponseCodeStatus.VERIFIED, result: VERIFIED });
    expect(redis.ttls.get(`verification:response-code:${token}`)).toBe(5);
  });

  it('does not resurrect a session consumed between the webhook read and its write', async () => {
    const { service, redis } = makeService();
    const token = await service.createSession('org-1', 'thread-1', REDIRECT_URI);
    const realEval = redis.eval.bind(redis);
    let interleaved = false;
    jest.spyOn(redis, 'eval').mockImplementation(async (...args: Parameters<FakeRedis['eval']>) => {
      if (!interleaved) {
        interleaved = true;
        await service.markTerminalByThreadId('thread-1', ResponseCodeStatus.VERIFIED, VERIFIED);
        await service.consume(token, 'thread-1');
      }
      return realEval(...args);
    });

    await service.markTerminalByThreadId('thread-1', ResponseCodeStatus.FAILED, FAILED);

    expect(await service.getSession(token)).toBeNull();
    expect(await service.consume(token, 'thread-1')).toBe(false);
  });

  it('consumes exactly once and removes both keys', async () => {
    const { service, redis } = makeService();
    const token = await service.createSession('org-1', 'thread-1', REDIRECT_URI);

    expect(await service.consume(token, 'thread-1')).toBe(true);
    expect(await service.consume(token, 'thread-1')).toBe(false);
    expect(redis.store.size).toBe(0);
  });

  describe('when Redis is unavailable', () => {
    it('fails session creation instead of storing it anywhere else', async () => {
      const { service, redis } = makeService();
      redis.connected = false;

      await expect(service.createSession('org-1', 'thread-1', REDIRECT_URI)).rejects.toThrow();
      expect(redis.store.size).toBe(0);
    });

    it('fails reads instead of reporting the code as expired, and serves it again after recovery', async () => {
      const { service, redis } = makeService();
      const token = await service.createSession('org-1', 'thread-1', REDIRECT_URI);
      redis.connected = false;

      await expect(service.getSession(token)).rejects.toThrow();

      redis.connected = true;
      expect(await service.getSession(token)).toMatchObject({ status: ResponseCodeStatus.PENDING });
    });

    it('rejects when the create transaction is aborted, leaving no partial session', async () => {
      const { service, redis } = makeService();
      redis.failNextExec = true;

      await expect(service.createSession('org-1', 'thread-1', REDIRECT_URI)).rejects.toThrow(
        'Redis transaction was aborted'
      );
      expect(redis.store.size).toBe(0);
    });

    it('fails when the client was never initialised', async () => {
      const service = new ProofResponseCodeService();

      await expect(service.createSession('org-1', 'thread-1', REDIRECT_URI)).rejects.toThrow(
        'Redis client is not initialised'
      );
    });
  });

  describe('pending TTL configuration', () => {
    const original = process.env.PROOF_RESPONSE_CODE_PENDING_TTL_SECONDS;
    afterEach(() => {
      if (undefined === original) {
        delete process.env.PROOF_RESPONSE_CODE_PENDING_TTL_SECONDS;
      } else {
        process.env.PROOF_RESPONSE_CODE_PENDING_TTL_SECONDS = original;
      }
    });

    it('defaults when unset or invalid', () => {
      expect(resolvePendingTtlSeconds(undefined)).toBe(DEFAULT_PENDING_TTL_SECONDS);
      expect(resolvePendingTtlSeconds('')).toBe(DEFAULT_PENDING_TTL_SECONDS);
      expect(resolvePendingTtlSeconds('abc')).toBe(DEFAULT_PENDING_TTL_SECONDS);
      expect(resolvePendingTtlSeconds('0')).toBe(DEFAULT_PENDING_TTL_SECONDS);
      expect(resolvePendingTtlSeconds('-5')).toBe(DEFAULT_PENDING_TTL_SECONDS);
      expect(resolvePendingTtlSeconds('12.5')).toBe(DEFAULT_PENDING_TTL_SECONDS);
    });

    it('uses PROOF_RESPONSE_CODE_PENDING_TTL_SECONDS for new sessions', async () => {
      process.env.PROOF_RESPONSE_CODE_PENDING_TTL_SECONDS = '900';
      const { service, redis } = makeService();

      const token = await service.createSession('org-1', 'thread-1', REDIRECT_URI);

      expect(redis.ttls.get(`verification:response-code:${token}`)).toBe(900);
    });
  });
});
