import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import Redis, { ChainableCommander } from 'ioredis';
import { IResponseCodeResult, IResponseCodeSession, ResponseCodeStatus } from './response-code.interface';

const KEY_PREFIX = 'verification:response-code:';
const THREAD_INDEX_PREFIX = 'verification:idx:thread:';
export const DEFAULT_PENDING_TTL_SECONDS = 600;
export const RESULT_READY_TTL_SECONDS = 60;

// Compare-and-set: writes only if the session still holds the exact value that was read, so a
// consumed (deleted) or already-terminal session is never recreated or re-extended.
const MARK_TERMINAL_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

export function resolvePendingTtlSeconds(value?: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && 0 < parsed ? parsed : DEFAULT_PENDING_TTL_SECONDS;
}

/**
 * Single-use response_code sessions for DIDComm same-device redirects. Redis is the only store,
 * so every replica sees the same state; while it is unavailable, operations fail instead of diverging.
 */
@Injectable()
export class ProofResponseCodeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ProofResponseCodeService');
  private client?: Redis;
  private readonly pendingTtlSeconds = resolvePendingTtlSeconds(process.env.PROOF_RESPONSE_CODE_PENDING_TTL_SECONDS);

  onModuleInit(): void {
    this.client = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
      // Fail commands immediately while disconnected instead of queueing them.
      enableOfflineQueue: false,
      retryStrategy: (times: number) => Math.min(times * 200, 2000)
    });
    this.client.on('ready', () => this.logger.log('Redis connection ready for response_code sessions'));
    this.client.on('error', (err: Error) => this.logger.warn(`Redis connection error: ${err?.message}`));
  }

  async onModuleDestroy(): Promise<void> {
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
    await this.exec(
      this.redis()
        .multi()
        .set(this.tokenKey(token), JSON.stringify(session), 'EX', this.pendingTtlSeconds)
        .set(this.threadIndexKey(threadId), token, 'EX', this.pendingTtlSeconds)
    );
    return token;
  }

  async getSession(token: string): Promise<IResponseCodeSession | null> {
    const raw = await this.redis().get(this.tokenKey(token));
    return raw ? (JSON.parse(raw) as IResponseCodeSession) : null;
  }

  /** No-op when the proof has no session, it was already consumed, or it is already terminal. */
  async markTerminalByThreadId(
    threadId: string,
    status: ResponseCodeStatus.VERIFIED | ResponseCodeStatus.FAILED,
    result: IResponseCodeResult
  ): Promise<void> {
    const indexKey = this.threadIndexKey(threadId);
    const token = await this.redis().get(indexKey);
    if (!token) {
      return;
    }
    const tokenKey = this.tokenKey(token);
    const raw = await this.redis().get(tokenKey);
    if (!raw) {
      return;
    }
    const session = JSON.parse(raw) as IResponseCodeSession;
    if (ResponseCodeStatus.PENDING !== session.status) {
      return;
    }
    const updated = JSON.stringify({ ...session, status, result });
    const applied = await this.redis().eval(
      MARK_TERMINAL_SCRIPT,
      2,
      tokenKey,
      indexKey,
      raw,
      updated,
      RESULT_READY_TTL_SECONDS
    );
    if (1 === applied) {
      this.logger.log(`response_code session for threadId ${threadId} set to ${status}`);
    } else {
      this.logger.debug(`response_code session for threadId ${threadId} changed concurrently; update skipped`);
    }
  }

  /** Returns false when a concurrent reader already consumed the token. */
  async consume(token: string, threadId: string): Promise<boolean> {
    const [deletedTokens] = await this.exec(
      this.redis().multi().del(this.tokenKey(token)).del(this.threadIndexKey(threadId))
    );
    return 1 === deletedTokens;
  }

  private redis(): Redis {
    if (!this.client) {
      throw new Error('Redis client is not initialised');
    }
    return this.client;
  }

  private async exec(transaction: ChainableCommander): Promise<unknown[]> {
    const results = await transaction.exec();
    if (!results) {
      throw new Error('Redis transaction was aborted');
    }
    const failed = results.find(([error]) => error);
    if (failed) {
      throw failed[0];
    }
    return results.map(([, value]) => value);
  }

  private tokenKey(token: string): string {
    return `${KEY_PREFIX}${token}`;
  }

  private threadIndexKey(threadId: string): string {
    return `${THREAD_INDEX_PREFIX}${threadId}`;
  }
}
