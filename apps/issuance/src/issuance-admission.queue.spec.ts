import { IssuanceAdmissionQueue } from './issuance-admission.queue';
import { performance } from 'perf_hooks';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

it('removes expired waiters immediately so they do not exhaust queue capacity', async () => {
  const queue = new IssuanceAdmissionQueue(1, 1);
  let finish: () => void;
  const active = queue.run(() => {
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  }, performance.now() + 1000);
  await delay(1);
  const expired = jest.fn(async () => undefined);
  await expect(queue.run(expired, performance.now() + 10)).rejects.toThrow('wait exceeded');
  const next = jest.fn(async () => true);
  const waiting = queue.run(next, performance.now() + 1000);
  finish();
  await active;
  await expect(waiting).resolves.toBe(true);
  expect(expired).not.toHaveBeenCalled();
});

it('preserves FIFO, bounds pending work and releases slots after failures', async () => {
  const queue = new IssuanceAdmissionQueue(1, 2);
  let finish: () => void;
  const order: number[] = [];
  const active = queue.run(() => {
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  }, performance.now() + 1000);
  await delay(1);
  const jobs = [1, 2].map((index) => {
    return queue.run(async () => {
      order.push(index);
      if (1 === index) {
        throw new Error('synthetic');
      }
      return true;
    }, performance.now() + 1000);
  });
  const results = Promise.allSettled(jobs);
  await expect(queue.run(async () => undefined, performance.now() + 1000)).rejects.toThrow('queue is full');
  finish();
  await active;
  expect((await results).map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
  expect(order).toEqual([1, 2]);
});
