import { IssuanceWorkCoordinator, positiveIntegerSetting } from './issuance-work.coordinator';
import * as Queue from 'bull';
import { randomUUID } from 'crypto';
import { localRedis } from '../test/local-redis';

const integration = '1' === process.env.RUN_ISSUANCE_REDIS_TESTS ? describe : describe.skip;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('issuance budget configuration', () => {
  afterEach(() => {
    delete process.env.TEST_ISSUANCE_LIMIT;
  });
  it('uses the finite default only when omitted', () => {
    expect(positiveIntegerSetting('TEST_ISSUANCE_LIMIT', 8, 128)).toBe(8);
  });
  it.each(['0', '-1', '1.5', '', 'Infinity', '129', ' 8 ', 'secret-value'])(
    'rejects malformed setting %s without echoing it',
    (value) => {
      process.env.TEST_ISSUANCE_LIMIT = value;
      expect(() => positiveIntegerSetting('TEST_ISSUANCE_LIMIT', 8, 128)).toThrow(
        'TEST_ISSUANCE_LIMIT must be a positive integer no greater than 128'
      );
    }
  );
});

integration('distributed issuance budget with local Redis', () => {
  let queues: Queue.Queue[];
  let workers: IssuanceWorkCoordinator[];
  let prefix: string;
  beforeEach(async () => {
    process.env.ISSUANCE_GLOBAL_CONCURRENCY = '2';
    process.env.ISSUANCE_CAPACITY_WAIT_MS = '1000';
    prefix = `issuance-test-${randomUUID()}`;
    const redis = localRedis();
    queues = Array.from({ length: 3 }, () => new Queue('bulk-issuance', { redis, prefix }));
    workers = queues.map((queue) => new IssuanceWorkCoordinator(queue));
    await Promise.all(queues.map((queue) => queue.isReady()));
  });
  afterEach(async () => {
    // Only keys belonging to this unique prefix in the guarded disposable fixture.
    const keys = await queues[0].client.keys(`${prefix}:*`);
    if (keys.length) {
      await queues[0].client.del(...keys);
    }
    await Promise.all(queues.map((queue) => queue.close()));
    delete process.env.ISSUANCE_GLOBAL_CONCURRENCY;
    delete process.env.ISSUANCE_CAPACITY_WAIT_MS;
  });

  it('bounds real overlapping work across clients, batches and direct offers', async () => {
    let active = 0;
    let peak = 0;
    const work = async (): Promise<boolean> => {
      active++;
      peak = Math.max(peak, active);
      await sleep(10);
      active--;
      return true;
    };
    const calls = Array.from({ length: 36 }, (_, index) => {
      const worker = workers[index % workers.length];
      return 0 === index % 2
        ? worker.offer(work)
        : worker.bulkRow('org', 'file', String(index), () => worker.offer(work));
    });
    await Promise.all(calls);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(await queues[0].client.exists(queues[0].toKey('offer-capacity-v1'))).toBe(0);
  });

  it('does not release a slot when work remains pending', async () => {
    let finish: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = workers[0].offer(() => pending);
    await sleep(30);
    expect(await queues[1].client.hlen(queues[1].toKey('offer-capacity-v1'))).toBe(2);
    finish();
    await work;
  });

  it('releases ordinary failed offers but blocks bulk replay after dispatch', async () => {
    await expect(
      workers[0].offer(async () => {
        throw new Error('synthetic');
      })
    ).rejects.toThrow('synthetic');
    await expect(workers[0].bulkRow('org', 'file', 'row', () => workers[0].offer(async () => false))).resolves.toBe(
      false
    );
    const replay = jest.fn(async () => true);
    await expect(workers[1].bulkRow('org', 'file', 'row', replay)).rejects.toThrow('uncertain outcome');
    expect(replay).not.toHaveBeenCalled();
  });

  it('allows retry after a failure before dispatch and isolates tenants', async () => {
    await expect(
      workers[0].bulkRow('org', 'file', 'row', async () => {
        throw new Error('validation');
      })
    ).rejects.toThrow('validation');
    await expect(workers[1].bulkRow('org', 'file', 'row', async () => true)).resolves.toBe(true);
    await workers[0].bulkRow('org', 'file', 'row', () => workers[0].offer(async () => false));
    await expect(workers[1].bulkRow('different-org', 'file', 'row', async () => true)).resolves.toBe(true);
  });

  it('retains a guard after successful dispatch followed by persistence failure', async () => {
    await expect(
      workers[0].bulkRow('org', 'file', 'row', async () => {
        await workers[0].offer(async () => true);
        throw new Error('persistence');
      })
    ).rejects.toThrow('persistence');
    await expect(workers[1].bulkRow('org', 'file', 'row', async () => true)).rejects.toThrow('reconcile');
  });

  it('fails closed when capacity is occupied and never starts timed-out work', async () => {
    const key = queues[0].toKey('offer-capacity-v1');
    await queues[0].client.hset(key, 'capacity', 2, 'owner-a', 1, 'owner-b', 1);
    process.env.ISSUANCE_CAPACITY_WAIT_MS = '20';
    const worker = new IssuanceWorkCoordinator(queues[0]);
    const work = jest.fn(async () => true);
    await expect(worker.offer(work)).rejects.toThrow('no offer was dispatched');
    expect(work).not.toHaveBeenCalled();
    expect(await queues[0].client.hlen(key)).toBe(3);
    expect(await queues[0].client.ttl(key)).toBe(-1);
  });

  it('does not time out an operation after it has actually started', async () => {
    process.env.ISSUANCE_CAPACITY_WAIT_MS = '20';
    const worker = new IssuanceWorkCoordinator(queues[0]);
    await expect(
      worker.offer(async () => {
        await sleep(80);
        return true;
      })
    ).resolves.toBe(true);
  });

  it('never dispatches queued work after its admission timeout', async () => {
    process.env.ISSUANCE_GLOBAL_CONCURRENCY = '8';
    process.env.ISSUANCE_CAPACITY_WAIT_MS = '50';
    const worker = new IssuanceWorkCoordinator(queues[0]);
    let finish: () => void;
    let started = 0;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = Array.from({ length: 8 }, () => {
      return worker.offer(async () => {
        started++;
        await pending;
      });
    });
    for (let i = 0; 8 > started && 100 > i; i++) {
      await sleep(1);
    }
    expect(started).toBe(8);
    const late = jest.fn(async () => true);
    await expect(worker.offer(late)).rejects.toThrow('no offer was dispatched');
    finish();
    await Promise.all(active);
    await sleep(20);
    expect(late).not.toHaveBeenCalled();
  });

  it('rejects inconsistent worker budgets without stealing existing slots', async () => {
    const key = queues[0].toKey('offer-capacity-v1');
    await queues[0].client.hset(key, 'capacity', 2, 'owner-a', 1);
    process.env.ISSUANCE_GLOBAL_CONCURRENCY = '3';
    await expect(new IssuanceWorkCoordinator(queues[1]).offer(async () => true)).rejects.toThrow('inconsistent');
    expect(await queues[0].client.hget(key, 'owner-a')).toBe('1');
  });

  it('rejects explicit retries of uncertain or still-active rows before enqueue', async () => {
    await workers[0].bulkRow('org', 'file', 'row', () => workers[0].offer(async () => false));
    await expect(workers[1].assertRetryable('org', 'file', ['row'])).rejects.toThrow('reconcile');
    await expect(workers[1].assertRetryable('ORG', 'FILE', ['ROW'])).rejects.toThrow('reconcile');
    await expect(workers[1].assertRetryable('org', 'file', ['different-row'])).resolves.toBeUndefined();
  });

  it('counts completed rows across replicas only once, not rows that merely started', async () => {
    await expect(workers[0].completedRow('batch', 'row-2', 3)).resolves.toBe(false);
    await expect(workers[1].completedRow('BATCH', 'ROW-2', 3)).resolves.toBe(false);
    await expect(workers[2].completedRow('batch', 'row-1', 3)).resolves.toBe(false);
    await expect(workers[0].completedRow('batch', 'row-3', 3)).resolves.toBe(true);
    await expect(workers[1].completedRow('batch', 'row-3', 3)).resolves.toBe(false);
  });
});
