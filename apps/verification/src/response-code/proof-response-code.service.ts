import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import Redis, { ChainableCommander } from 'ioredis';
import {
  IHostedSession,
  IResponseCodeResult,
  IResponseCodeSession,
  ResponseCodeStatus,
  TerminalResponseCodeStatus
} from './response-code.interface';

const KEY_PREFIX = 'verification:response-code:';
const THREAD_INDEX_PREFIX = 'verification:idx:thread:';
const HOSTED_PREFIX = 'verification:hosted:';
const HOSTED_THREAD_INDEX_PREFIX = 'verification:idx:hosted-thread:';
const HOSTED_OOB_INDEX_PREFIX = 'verification:idx:hosted-oob:';
const HOSTED_SCANNED_PREFIX = 'verification:hosted-scanned:';
const HOSTED_SCAN_PREFIX = 'verification:hosted-scan:';
const HOSTED_RATE_PREFIX = 'verification:rate:hosted:';
/** Window of the per-hostedId read limit on the status endpoint (DL-008). */
export const HOSTED_RATE_WINDOW_SECONDS = 60;

/**
 * The token in the hosted page's scan link. Hex, so it can never contain `oob`, `c_i` or `d_m`, which the wallet would
 * take for an inline invitation.
 */
export function newHostedScanToken(): string {
  return randomBytes(32).toString('hex');
}
export const DEFAULT_PENDING_TTL_SECONDS = 600;
export const DEFAULT_RESULT_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 3600;
/** Covers delivering a result that lands right at the request deadline. */
export const REQUEST_DEADLINE_GRACE_SECONDS = 30;

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

/** Whole seconds in (0, MAX_TTL_SECONDS]; anything else falls back to `fallback`. */
export function resolveTtlSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && 0 < parsed && MAX_TTL_SECONDS >= parsed ? parsed : fallback;
}

/**
 * Single-use response_code sessions for DIDComm same-device redirects. Redis is the only store,
 * so every replica sees the same state; while it is unavailable, operations fail instead of diverging.
 */
@Injectable()
export class ProofResponseCodeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ProofResponseCodeService');
  private client?: Redis;
  private readonly pendingTtlSeconds = this.ttlFromEnv(
    'PROOF_RESPONSE_CODE_PENDING_TTL_SECONDS',
    DEFAULT_PENDING_TTL_SECONDS
  );

  private readonly resultTtlSeconds = this.ttlFromEnv(
    'PROOF_RESPONSE_CODE_RESULT_TTL_SECONDS',
    DEFAULT_RESULT_TTL_SECONDS
  );

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

  /**
   * `requestExpiresInSeconds` is the proof request's own lifetime: the session lives that long plus a short grace, so
   * a citizen who approves before the request expires still gets a usable response_code. Without it the session
   * falls back to PROOF_RESPONSE_CODE_PENDING_TTL_SECONDS.
   */
  async createSession(
    orgId: string,
    threadId: string,
    redirectUri: string,
    requestExpiresInSeconds?: number
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const session: IResponseCodeSession = {
      orgId,
      threadId,
      redirectUri,
      status: ResponseCodeStatus.PENDING,
      createdAt: new Date().toISOString()
    };
    const ttlSeconds = this.sessionTtlSeconds(requestExpiresInSeconds);
    await this.exec(
      this.redis()
        .multi()
        .set(this.tokenKey(token), JSON.stringify(session), 'EX', ttlSeconds)
        .set(this.threadIndexKey(threadId), token, 'EX', ttlSeconds)
    );
    return token;
  }

  /** The request deadline plus grace, or the configured pending TTL when the request has no known lifetime. */
  sessionTtlSeconds(requestExpiresInSeconds?: number): number {
    return Number.isInteger(requestExpiresInSeconds) && 0 < requestExpiresInSeconds
      ? requestExpiresInSeconds + REQUEST_DEADLINE_GRACE_SECONDS
      : this.pendingTtlSeconds;
  }

  async getSession(token: string): Promise<IResponseCodeSession | null> {
    const raw = await this.redis().get(this.tokenKey(token));
    return raw ? (JSON.parse(raw) as IResponseCodeSession) : null;
  }

  /** No-op when the proof has no session, it was already consumed, or it is already terminal. */
  async markTerminalByThreadId(
    threadId: string,
    status: TerminalResponseCodeStatus,
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
      this.resultTtlSeconds
    );
    if (1 === applied) {
      this.logger.log(`response_code session for threadId ${threadId} set to ${status}`);
    } else {
      this.logger.debug(`response_code session for threadId ${threadId} changed concurrently; update skipped`);
    }
  }

  /** Reads a proof's session through the thread index without consuming it (HVP-SD §5.3). */
  async getSessionByThreadId(threadId: string): Promise<IResponseCodeSession | null> {
    const token = await this.redis().get(this.threadIndexKey(threadId));
    return token ? this.getSession(token) : null;
  }

  /** How long a response_code can still be exchanged, in ms; 0 once its session is gone. */
  async responseCodeRemainingMs(token: string): Promise<number> {
    const remainingMs = await this.redis().pttl(this.tokenKey(token));
    return 0 < remainingMs ? remainingMs : 0;
  }

  /**
   * Stores the hosted page's session. The caller gives it the response_code session's lifetime plus one more grace
   * period, so the page can still read `expired` after the code session ends.
   */
  async createHostedSession(
    session: Omit<IHostedSession, 'hostedId'>,
    ttlSeconds: number,
    scanToken?: string
  ): Promise<string> {
    const hostedId = randomBytes(32).toString('base64url');
    const transaction = this.redis()
      .multi()
      .set(this.hostedKey(hostedId), JSON.stringify({ hostedId, ...session }), 'EX', ttlSeconds)
      .set(this.hostedThreadIndexKey(session.threadId), hostedId, 'EX', ttlSeconds);
    if (session.outOfBandId) {
      transaction.set(this.hostedOutOfBandIndexKey(session.outOfBandId), hostedId, 'EX', ttlSeconds);
    }
    if (scanToken) {
      // Lives as long as the session, so the link answers every fetch (rescans included) until the session ends.
      transaction.set(this.hostedScanKey(scanToken), hostedId, 'EX', ttlSeconds);
    }
    await this.exec(transaction);
    return hostedId;
  }

  async getHostedSession(hostedId: string): Promise<IHostedSession | null> {
    const raw = await this.redis().get(this.hostedKey(hostedId));
    return raw ? (JSON.parse(raw) as IHostedSession) : null;
  }

  /** Keeps the proof's outcome on its hosted session, if it has one. The session's expiry is unchanged. */
  async recordHostedOutcome(threadId: string, outcome: TerminalResponseCodeStatus): Promise<void> {
    const hostedId = await this.redis().get(this.hostedThreadIndexKey(threadId));
    if (!hostedId) {
      return;
    }
    const session = await this.getHostedSession(hostedId);
    if (!session || session.outcome) {
      return;
    }
    // XX: if the session expired since the read, do not recreate it without an expiry.
    await this.redis().set(this.hostedKey(hostedId), JSON.stringify({ ...session, outcome }), 'KEEPTTL', 'XX');
  }

  /** The hosted session a scan link points to, or null when the token is unknown or the session has ended. */
  async resolveHostedScan(scanToken: string): Promise<string | null> {
    return this.redis().get(this.hostedScanKey(scanToken));
  }

  /** From a connection or handshake-reuse event: only for the org that created the request (DL-016). */
  async markHostedScanned(outOfBandId: string, orgId: string): Promise<boolean> {
    const hostedId = await this.redis().get(this.hostedOutOfBandIndexKey(outOfBandId));
    if (!hostedId) {
      return false;
    }
    return this.markHostedScannedById(hostedId, orgId);
  }

  /**
   * The flag is its own key, so it can't overwrite an outcome recorded meanwhile (DL-016). With `orgId`, only a session
   * of that org is marked; the scan link needs no org check, as its token already names the session.
   */
  async markHostedScannedById(hostedId: string, orgId?: string): Promise<boolean> {
    const session = await this.getHostedSession(hostedId);
    if (!session || (orgId && session.orgId !== orgId)) {
      return false;
    }
    return this.markHostedSessionScanned(session);
  }

  /** For a caller that has already read the session, such as the scan link. */
  async markHostedSessionScanned(session: IHostedSession): Promise<boolean> {
    if (session.outcome) {
      return false;
    }
    const { hostedId } = session;
    const remainingMs = await this.redis().pttl(this.hostedKey(hostedId));
    if (0 >= remainingMs) {
      return false;
    }
    const applied = await this.redis().set(this.hostedScannedKey(hostedId), '1', 'PX', remainingMs, 'NX');
    return 'OK' === applied;
  }

  async isHostedScanned(hostedId: string): Promise<boolean> {
    return null !== (await this.redis().get(this.hostedScannedKey(hostedId)));
  }

  /** Counts a status read for a hosted page in the current window; the caller decides the limit (DL-008). */
  async countHostedStatusRead(hostedId: string): Promise<number> {
    const key = `${HOSTED_RATE_PREFIX}${hostedId}`;
    // One transaction, so the window's expiry is always set with the counter.
    const [, count] = await this.exec(
      this.redis().multi().set(key, 0, 'EX', HOSTED_RATE_WINDOW_SECONDS, 'NX').incr(key)
    );
    return count as number;
  }

  /** Returns false when a concurrent reader already consumed the token. */
  async consume(token: string, threadId: string): Promise<boolean> {
    const [deletedTokens] = await this.exec(
      this.redis().multi().del(this.tokenKey(token)).del(this.threadIndexKey(threadId))
    );
    return 1 === deletedTokens;
  }

  private ttlFromEnv(name: string, fallback: number): number {
    const value = process.env[name];
    const ttl = resolveTtlSeconds(value, fallback);
    if (value?.trim() && ttl !== Number(value)) {
      this.logger.warn(
        `${name}=${value} is not a whole number of seconds in (0, ${MAX_TTL_SECONDS}]; using ${fallback}`
      );
    }
    return ttl;
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

  private hostedKey(hostedId: string): string {
    return `${HOSTED_PREFIX}${hostedId}`;
  }

  private hostedThreadIndexKey(threadId: string): string {
    return `${HOSTED_THREAD_INDEX_PREFIX}${threadId}`;
  }

  private hostedOutOfBandIndexKey(outOfBandId: string): string {
    return `${HOSTED_OOB_INDEX_PREFIX}${outOfBandId}`;
  }

  private hostedScanKey(scanToken: string): string {
    return `${HOSTED_SCAN_PREFIX}${scanToken}`;
  }

  private hostedScannedKey(hostedId: string): string {
    return `${HOSTED_SCANNED_PREFIX}${hostedId}`;
  }
}
