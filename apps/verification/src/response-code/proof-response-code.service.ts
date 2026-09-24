import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import Redis from 'ioredis';
import { IResponseCodeResult, IResponseCodeSession, ResponseCodeStatus } from './response-code.interface';

const KEY_PREFIX = 'verification:response-code:';
const THREAD_INDEX_PREFIX = 'verification:idx:thread:';
export const PENDING_TTL_SECONDS = 300;
export const RESULT_READY_TTL_SECONDS = 60;

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

/**
 * Single-use response_code sessions for DIDComm same-device redirects. Redis is the
 * primary store so any replica can serve the webhook or the read; a per-instance
 * in-memory fallback keeps proof requests working while Redis is down.
 */
@Injectable()
export class ProofResponseCodeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ProofResponseCodeService');
  private client?: Redis;
  private readonly memory = new Map<string, MemoryEntry>();
  private sweepTimer?: NodeJS.Timeout;
  private lastFallbackLogAt = 0;

  onModuleInit(): void {
    this.client = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
      // Fail commands fast (fall back to memory) instead of queueing while disconnected.
      enableOfflineQueue: false,
      retryStrategy: (times: number) => Math.min(times * 200, 2000)
    });
    this.client.on('ready', () => this.logger.log('Redis connection ready for response_code sessions'));
    this.client.on('error', (err: Error) => this.logger.debug(`Redis connection error: ${err?.message}`));

    this.sweepTimer = setInterval(() => this.sweepMemory(), 60_000);
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
    }
  }

  async createSession(orgId: string, threadId: string, redirectUri: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const session: IResponseCodeSession = {
      orgId,
      threadId,
      redirectUri,
      status: ResponseCodeStatus.PENDING,
      createdAt: new Date().toISOString()
    };
    await this.kvSet(this.tokenKey(token), JSON.stringify(session), PENDING_TTL_SECONDS);
    await this.kvSet(this.threadIndexKey(threadId), token, PENDING_TTL_SECONDS);
    if (!this.redisReady()) {
      this.logger.warn(
        `response_code session for threadId ${threadId} stored in the in-memory fallback (Redis unavailable); it is NOT visible to other replicas`
      );
    }
    return token;
  }

  async getSession(token: string): Promise<IResponseCodeSession | null> {
    const raw = await this.kvGet(this.tokenKey(token));
    return raw ? (JSON.parse(raw) as IResponseCodeSession) : null;
  }

  /** No-op when the proof has no response_code session (i.e. no redirectUri was supplied). */
  async markTerminalByThreadId(
    threadId: string,
    status: ResponseCodeStatus.VERIFIED | ResponseCodeStatus.FAILED,
    result: IResponseCodeResult
  ): Promise<void> {
    const token = await this.kvGet(this.threadIndexKey(threadId));
    if (!token) {
      if (!this.redisReady()) {
        this.logger.warn(
          `No response_code session for threadId ${threadId} while on the in-memory fallback — possible cross-replica miss`
        );
      }
      return;
    }
    const session = await this.getSession(token);
    if (!session) {
      return;
    }
    session.status = status;
    session.result = result;
    await this.kvSet(this.tokenKey(token), JSON.stringify(session), RESULT_READY_TTL_SECONDS);
    await this.kvExpire(this.threadIndexKey(threadId), RESULT_READY_TTL_SECONDS);
    this.logger.log(`response_code session for threadId ${threadId} set to ${status}`);
  }

  /** Returns false when a concurrent reader already consumed the token. */
  async consume(token: string, threadId: string): Promise<boolean> {
    const deleted = await this.kvDel(this.tokenKey(token));
    await this.kvDel(this.threadIndexKey(threadId));
    return deleted;
  }

  private tokenKey(token: string): string {
    return `${KEY_PREFIX}${token}`;
  }

  private threadIndexKey(threadId: string): string {
    return `${THREAD_INDEX_PREFIX}${threadId}`;
  }

  // Derived per operation rather than a sticky flag, so a transient failure self-heals.
  private redisReady(): boolean {
    return 'ready' === this.client?.status;
  }

  private async kvSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redisReady()) {
      try {
        await this.client.set(key, value, 'EX', ttlSeconds);
        return;
      } catch (err) {
        this.onRedisOpError(err);
      }
    }
    const ttlMs = ttlSeconds * 1000;
    this.memory.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  private async kvGet(key: string): Promise<string | null> {
    if (this.redisReady()) {
      try {
        return await this.client.get(key);
      } catch (err) {
        this.onRedisOpError(err);
      }
    }
    return this.memGet(key);
  }

  private async kvDel(key: string): Promise<boolean> {
    if (this.redisReady()) {
      try {
        return 1 === (await this.client.del(key));
      } catch (err) {
        this.onRedisOpError(err);
      }
    }
    const existed = null !== this.memGet(key);
    this.memory.delete(key);
    return existed;
  }

  private async kvExpire(key: string, ttlSeconds: number): Promise<void> {
    if (this.redisReady()) {
      try {
        await this.client.expire(key, ttlSeconds);
        return;
      } catch (err) {
        this.onRedisOpError(err);
      }
    }
    const entry = this.memory.get(key);
    if (entry) {
      const ttlMs = ttlSeconds * 1000;
      entry.expiresAt = Date.now() + ttlMs;
    }
  }

  private onRedisOpError(err: unknown): void {
    const now = Date.now();
    if (30_000 < now - this.lastFallbackLogAt) {
      this.lastFallbackLogAt = now;
      this.logger.warn(`Redis command failed; used in-memory fallback for this operation: ${(err as Error)?.message}`);
    }
  }

  private memGet(key: string): string | null {
    const entry = this.memory.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  private sweepMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory.entries()) {
      if (now > entry.expiresAt) {
        this.memory.delete(key);
      }
    }
  }
}
