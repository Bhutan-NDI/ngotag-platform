import {
  DEFAULT_PENDING_TTL_SECONDS,
  ProofResponseCodeService,
  RESULT_READY_TTL_SECONDS,
  resolvePendingTtlSeconds
} from '../proof-response-code.service';
import { ResponseCodeStatus } from '../response-code.interface';

const RESULT = { state: 'done', isVerified: true, presentationId: 'pres-1' };

function makeFakeRedis(): { client: Record<string, jest.Mock | string>; store: Map<string, string> } {
  const store = new Map<string, string>();
  const client = {
    status: 'ready',
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    expire: jest.fn(async () => 1)
  };
  return { client, store };
}

describe('ProofResponseCodeService', () => {
  describe('with Redis available', () => {
    let service: ProofResponseCodeService;
    let fake: ReturnType<typeof makeFakeRedis>;

    beforeEach(() => {
      service = new ProofResponseCodeService();
      fake = makeFakeRedis();
      (service as unknown as { client: unknown }).client = fake.client;
    });

    it('mints an opaque 256-bit token and stores a pending session plus a namespaced thread index', async () => {
      const token = await service.createSession('org-1', 'thread-1', 'https://rp.example.com/return');

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fake.client.set).toHaveBeenCalledWith(
        `verification:response-code:${token}`,
        expect.any(String),
        'EX',
        DEFAULT_PENDING_TTL_SECONDS
      );
      expect(fake.store.get('verification:idx:thread:thread-1')).toBe(token);
      expect(await service.getSession(token)).toMatchObject({
        orgId: 'org-1',
        threadId: 'thread-1',
        status: ResponseCodeStatus.PENDING
      });
    });

    it('moves the session to terminal by threadId and shortens both TTLs', async () => {
      const token = await service.createSession('org-1', 'thread-1', 'https://rp.example.com/return');

      await service.markTerminalByThreadId('thread-1', ResponseCodeStatus.VERIFIED, RESULT);

      expect(await service.getSession(token)).toMatchObject({ status: ResponseCodeStatus.VERIFIED, result: RESULT });
      expect(fake.client.set).toHaveBeenLastCalledWith(
        `verification:response-code:${token}`,
        expect.any(String),
        'EX',
        RESULT_READY_TTL_SECONDS
      );
      expect(fake.client.expire).toHaveBeenCalledWith('verification:idx:thread:thread-1', RESULT_READY_TTL_SECONDS);
    });

    it('is a no-op for a proof that has no session', async () => {
      await service.markTerminalByThreadId('unknown-thread', ResponseCodeStatus.FAILED, RESULT);

      expect(fake.client.set).not.toHaveBeenCalled();
    });

    it('consumes exactly once', async () => {
      const token = await service.createSession('org-1', 'thread-1', 'https://rp.example.com/return');

      expect(await service.consume(token, 'thread-1')).toBe(true);
      expect(await service.consume(token, 'thread-1')).toBe(false);
      expect(fake.store.size).toBe(0);
    });

    it('falls back to memory for an operation when a Redis command throws', async () => {
      fake.client.set = jest.fn(async () => {
        throw new Error('boom');
      });
      fake.client.get = jest.fn(async () => {
        throw new Error('boom');
      });

      const token = await service.createSession('org-1', 'thread-1', 'https://rp.example.com/return');

      expect(await service.getSession(token)).toMatchObject({ threadId: 'thread-1' });
    });
  });

  describe('with Redis unavailable (in-memory fallback)', () => {
    it('supports the full pending -> terminal -> consumed lifecycle', async () => {
      const service = new ProofResponseCodeService();

      const token = await service.createSession('org-1', 'thread-1', 'https://rp.example.com/return');
      expect((await service.getSession(token))?.status).toBe(ResponseCodeStatus.PENDING);

      await service.markTerminalByThreadId('thread-1', ResponseCodeStatus.FAILED, {
        state: 'abandoned',
        isVerified: false
      });
      expect((await service.getSession(token))?.status).toBe(ResponseCodeStatus.FAILED);

      expect(await service.consume(token, 'thread-1')).toBe(true);
      expect(await service.getSession(token)).toBeNull();
    });

    it('expires sessions after their TTL', async () => {
      jest.useFakeTimers();
      try {
        const service = new ProofResponseCodeService();
        const token = await service.createSession('org-1', 'thread-1', 'https://rp.example.com/return');

        jest.advanceTimersByTime((DEFAULT_PENDING_TTL_SECONDS + 1) * 1000);

        expect(await service.getSession(token)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
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
      const service = new ProofResponseCodeService();
      const fake = makeFakeRedis();
      (service as unknown as { client: unknown }).client = fake.client;

      await service.createSession('org-1', 'thread-1', 'https://rp.example.com/return');

      expect(fake.client.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', 900);
    });
  });
});
