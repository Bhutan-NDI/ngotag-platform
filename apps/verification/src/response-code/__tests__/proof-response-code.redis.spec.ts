// Runs against a real Redis only when REDIS_TEST_HOST is set (e.g. REDIS_TEST_HOST=localhost);
// uses REDIS_TEST_DB (default 15) and deletes only the keys it creates.
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { ProofResponseCodeService, RESULT_READY_TTL_SECONDS } from '../proof-response-code.service';
import { ResponseCodeStatus } from '../response-code.interface';

const describeWithRedis = process.env.REDIS_TEST_HOST ? describe : describe.skip;
const VERIFIED = { state: 'done', isVerified: true, presentationId: 'pres-1' };
const FAILED = { state: 'abandoned', isVerified: false };

describeWithRedis('ProofResponseCodeService against Redis', () => {
  let client: Redis;
  let service: ProofResponseCodeService;
  const createdKeys: string[] = [];

  const tokenKey = (token: string): string => `verification:response-code:${token}`;
  const indexKey = (threadId: string): string => `verification:idx:thread:${threadId}`;

  async function newSession(): Promise<{ token: string; threadId: string }> {
    const threadId = `test-${randomUUID()}`;
    const token = await service.createSession('org-1', threadId, 'https://rp.example.com/return');
    createdKeys.push(tokenKey(token), indexKey(threadId));
    return { token, threadId };
  }

  /** Runs `hook` right before the next write (SET ... EX / EVAL) that targets `key`. */
  function beforeNextWriteTo(key: string, hook: () => Promise<void>): void {
    const target = client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of ['set', 'eval']) {
      const original = target[method].bind(client);
      target[method] = async (...args: unknown[]): Promise<unknown> => {
        if (args.includes(key)) {
          delete target.set;
          delete target.eval;
          await hook();
        }
        return original(...args);
      };
    }
  }

  beforeAll(async () => {
    client = new Redis({
      host: process.env.REDIS_TEST_HOST,
      port: Number(process.env.REDIS_TEST_PORT || 6379),
      password: process.env.REDIS_TEST_PASSWORD || undefined,
      db: Number(process.env.REDIS_TEST_DB || 15),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true
    });
    await client.connect();
  });

  beforeEach(() => {
    service = new ProofResponseCodeService();
    (service as unknown as { client: Redis }).client = client;
  });

  afterAll(async () => {
    if (createdKeys.length) {
      await client.del(...createdKeys);
    }
    await client.quit();
  });

  it('creates the session and thread index together with the pending TTL', async () => {
    const { token, threadId } = await newSession();

    expect(await client.get(indexKey(threadId))).toBe(token);
    expect(await client.ttl(tokenKey(token))).toBeGreaterThan(RESULT_READY_TTL_SECONDS);
    expect(await client.ttl(indexKey(threadId))).toBeGreaterThan(RESULT_READY_TTL_SECONDS);
  });

  it('never resurrects a session consumed while a concurrent terminal webhook is in flight', async () => {
    const { token, threadId } = await newSession();

    // Webhook A has read the pending session; before it writes, webhook B completes it and the
    // browser consumes the result.
    beforeNextWriteTo(tokenKey(token), async () => {
      await service.markTerminalByThreadId(threadId, ResponseCodeStatus.VERIFIED, VERIFIED);
      expect(await service.consume(token, threadId)).toBe(true);
    });
    await service.markTerminalByThreadId(threadId, ResponseCodeStatus.FAILED, FAILED);

    expect(await service.getSession(token)).toBeNull();
    expect(await client.exists(indexKey(threadId))).toBe(0);
    expect(await service.consume(token, threadId)).toBe(false);
  });

  it('does not overwrite or re-extend an already terminal result', async () => {
    const { token, threadId } = await newSession();
    await service.markTerminalByThreadId(threadId, ResponseCodeStatus.VERIFIED, VERIFIED);
    await client.pexpire(tokenKey(token), 5_000);

    await service.markTerminalByThreadId(threadId, ResponseCodeStatus.FAILED, FAILED);

    expect(await service.getSession(token)).toMatchObject({ status: ResponseCodeStatus.VERIFIED, result: VERIFIED });
    expect(await client.pttl(tokenKey(token))).toBeLessThanOrEqual(5_000);
  });

  it('lets exactly one of several concurrent readers consume a terminal result', async () => {
    const { token, threadId } = await newSession();
    await service.markTerminalByThreadId(threadId, ResponseCodeStatus.VERIFIED, VERIFIED);

    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => service.consume(token, threadId)));

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('fails while disconnected and serves the same state after reconnecting', async () => {
    const { token } = await newSession();

    client.disconnect();
    await expect(service.getSession(token)).rejects.toThrow();
    await expect(
      service.createSession('org-1', `test-${randomUUID()}`, 'https://rp.example.com/return')
    ).rejects.toThrow();

    if ('end' !== client.status) {
      await new Promise((resolve) => client.once('end', resolve));
    }
    await client.connect();
    expect(await service.getSession(token)).toMatchObject({ status: ResponseCodeStatus.PENDING });
    await expect(newSession()).resolves.toBeDefined();
  });
});
