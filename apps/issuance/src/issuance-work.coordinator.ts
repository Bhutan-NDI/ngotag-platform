import { InjectQueue } from '@nestjs/bull';
import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bull';
import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { IssuanceAdmissionQueue } from './issuance-admission.queue';
import { issuanceDeadline, ISSUANCE_INTERACTIVE_QUEUE_MS } from '../../../libs/context/src/issuanceDeadline';

export function positiveIntegerSetting(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (undefined === raw) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return Number(raw);
}

export const ISSUANCE_WORKER_CONCURRENCY = positiveIntegerSetting('ISSUANCE_WORKER_CONCURRENCY', 8, 128);

// Only unactivated reservations expire; dispatched work remains pinned until completion.
const RESERVATION_MS = 30000;
const ACQUIRE = `
local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local entries = redis.call('HGETALL', KEYS[1])
for i = 1, #entries, 2 do
  if string.sub(entries[i+1], 1, 2) == 'r:' and tonumber(string.sub(entries[i+1], 3)) <= ms then
    redis.call('HDEL', KEYS[1], entries[i])
  end
end
if redis.call('HLEN', KEYS[1]) == 1 then redis.call('DEL', KEYS[1]) end
local capacity = redis.call('HGET', KEYS[1], 'capacity')
if capacity and tonumber(capacity) ~= tonumber(ARGV[1]) then return -1 end
if redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then return 1 end
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[1]) + 1 then return 0 end
redis.call('HSET', KEYS[1], 'capacity', ARGV[1], ARGV[2], 'r:' .. (ms + tonumber(ARGV[3])))
return 1`;
const ACTIVATE = `
local value = redis.call('HGET', KEYS[1], ARGV[1])
local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if not value or string.sub(value, 1, 2) ~= 'r:' or tonumber(string.sub(value, 3)) <= ms then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'active:' .. ms)
return 1`;
const RELEASE = `
redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 1 then redis.call('DEL', KEYS[1]) end
return 1`;
const RELEASE_ROW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
const COMPLETE = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
local count = redis.call('SCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[1], 604800) end
if added == 1 and count == tonumber(ARGV[2]) then return 1 end
return 0`;

@Injectable()
export class IssuanceWorkCoordinator {
  private readonly capacity = positiveIntegerSetting('ISSUANCE_GLOBAL_CONCURRENCY', 8, 128);
  private readonly waitMs = positiveIntegerSetting('ISSUANCE_CAPACITY_WAIT_MS', 300000, 3600000);
  private readonly maxPending = positiveIntegerSetting('ISSUANCE_MAX_PENDING', 1000, 10000);
  private readonly offers = new IssuanceAdmissionQueue(
    Math.min(ISSUANCE_WORKER_CONCURRENCY, this.capacity),
    this.maxPending
  );
  private readonly rows = new IssuanceAdmissionQueue(ISSUANCE_WORKER_CONCURRENCY, this.maxPending);
  private readonly requestDeadline = new AsyncLocalStorage<number>();
  private readonly bulkContext = new AsyncLocalStorage<{ dispatched: boolean }>();

  constructor(@InjectQueue('bulk-issuance') private readonly queue: Queue) {}

  async interactive<T>(deadline: unknown, operation: () => Promise<T>): Promise<T> {
    const remaining = issuanceDeadline(deadline) - Date.now();
    return this.requestDeadline.run(performance.now() + remaining, operation);
  }

  async offer<T>(operation: () => Promise<T>): Promise<T> {
    return this.withPermit(async () => {
      const context = this.bulkContext.getStore();
      if (context) {
        context.dispatched = true;
      }
      return operation();
    });
  }

  private async withPermit<T>(operation: () => Promise<T>): Promise<T> {
    const isBulk = Boolean(this.bulkContext.getStore());
    const wait = isBulk ? this.waitMs : Math.min(this.waitMs, ISSUANCE_INTERACTIVE_QUEUE_MS);
    const deadline = Math.min(performance.now() + wait, this.requestDeadline.getStore() ?? Infinity);
    return this.offers.run(() => this.acquireAndRun(operation, deadline), deadline);
  }

  private async acquireAndRun<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    const owner = randomUUID();
    const key = this.queue.toKey('offer-capacity-v1');
    const checkWaiting = (): void => {
      if (performance.now() >= deadline) {
        throw new ServiceUnavailableException('Issuance capacity wait exceeded; no offer was dispatched');
      }
    };
    let acquired = false;
    let retryDelay = 1;
    try {
      while (!acquired) {
        checkWaiting();
        const result = Number(await this.queue.client.eval(ACQUIRE, 1, key, this.capacity, owner, RESERVATION_MS));
        if (-1 === result) {
          throw new ServiceUnavailableException('Issuance workers have inconsistent concurrency configuration');
        }
        acquired = 1 === result;
        if (!acquired) {
          const delay = Math.min(retryDelay, Math.max(1, deadline - performance.now()));
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delay);
          });
          retryDelay = Math.min(50, retryDelay * 2);
        }
      }
      checkWaiting();
      if (1 !== Number(await this.queue.client.eval(ACTIVATE, 1, key, owner))) {
        throw new ServiceUnavailableException('Issuance reservation expired; no offer was dispatched');
      }
      checkWaiting();
      return await operation();
    } finally {
      await this.releasePermit(key, owner);
    }
  }

  private async releasePermit(key: string, owner: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.queue.client.eval(RELEASE, 1, key, owner);
        return;
      } catch (error) {
        if (2 === attempt) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }

  async bulkRow<T extends boolean>(
    orgId: string,
    fileId: string,
    rowId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.rows.run(() => this.guardedRow(orgId, fileId, rowId, operation), performance.now() + this.waitMs);
  }

  private async guardedRow<T extends boolean>(
    orgId: string,
    fileId: string,
    rowId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = this.rowKey(orgId, fileId, rowId);
    const owner = randomUUID();
    const acquired = await this.queue.client.set(key, owner, 'NX');
    if ('OK' !== acquired) {
      throw new Error('Issuance row is active or has an uncertain outcome; reconcile before retrying');
    }
    const context = { dispatched: false };
    let success = false;
    try {
      const result = await this.bulkContext.run(context, operation);
      success = result;
      return result;
    } finally {
      // A failure after dispatch (including email/persistence failure) cannot be
      // safely replayed: the remote offer may already exist.
      if (success || !context.dispatched) {
        await this.queue.client.eval(RELEASE_ROW, 1, key, owner);
      }
    }
  }

  private rowKey(orgId: string, fileId: string, rowId: string): string {
    // PostgreSQL UUIDs are case-insensitive; guard the database identity.
    const identifiers = [orgId, fileId, rowId].map((value) => value.trim().toLowerCase());
    const identity = createHash('sha256').update(JSON.stringify(identifiers)).digest('hex');
    return this.queue.toKey(`issuance-row-v1-${identity}`);
  }

  async assertRetryable(orgId: string, fileId: string, rowIds: string[]): Promise<void> {
    for (let offset = 0; offset < rowIds.length; offset += 2000) {
      const keys = rowIds.slice(offset, offset + 2000).map((rowId) => {
        return this.rowKey(orgId, fileId, rowId);
      });
      const owners = await this.queue.client.mget(...keys);
      if (owners.some((owner) => null !== owner)) {
        throw new ConflictException('Some issuance rows are active or uncertain; reconcile before retrying');
      }
    }
  }

  async completedRow(batchId: string, rowId: string, total: number): Promise<boolean> {
    if (!batchId || !rowId || !Number.isSafeInteger(total) || 1 > total) {
      throw new Error('Invalid issuance batch completion metadata');
    }
    const key = this.queue.toKey(`issuance-completed-v1-${batchId.trim().toLowerCase()}`);
    return 1 === Number(await this.queue.client.eval(COMPLETE, 1, key, rowId.trim().toLowerCase(), total));
  }
}
