// Synthetic phase timings on the guarded local Redis fixture, never application data.
require('ts-node/register/transpile-only');
const Queue = require('bull');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const { writeFileSync } = require('fs');
const { localRedis } = require('../../apps/issuance/test/local-redis.ts');
const { IssuanceWorkCoordinator } = require('../../apps/issuance/src/issuance-work.coordinator.ts');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  process.env.ISSUANCE_GLOBAL_CONCURRENCY = '2';
  const prefix = `issuance-test-${randomUUID()}`;
  const queues = Array.from({ length: 3 }, () => new Queue('bulk-issuance', { redis: localRedis(), prefix }));
  const workers = queues.map((queue) => new IssuanceWorkCoordinator(queue));
  const results = [];
  try {
    await Promise.all(queues.map((queue) => queue.isReady()));
    for (let trial = 0; trial < 3; trial++) {
      for (const mode of trial % 2 ? ['offer-only', 'whole-row'] : ['whole-row', 'offer-only']) {
        let active = 0;
        let peak = 0;
        let completed = 0;
        const latencies = [];
        const started = performance.now();
        await Promise.all(
          Array.from({ length: 24 }, (_, index) => {
            const worker = workers[index % workers.length];
            const begin = performance.now();
            const offer = async () => {
              active++;
              peak = Math.max(peak, active);
              await sleep(5);
              active--;
            };
            return worker
              .bulkRow('synthetic', `${trial}-${mode}`, String(index), async () => {
                const phases = async (dispatch) => {
                  await sleep(20);
                  await dispatch();
                  await sleep(20);
                  completed++;
                  return true;
                };
                return mode === 'whole-row' ? worker.offer(() => phases(offer)) : phases(() => worker.offer(offer));
              })
              .then(() => latencies.push(performance.now() - begin));
          })
        );
        latencies.sort((a, b) => a - b);
        assert.equal(completed, 24);
        assert.equal(active, 0);
        assert.ok(peak <= 2);
        assert.equal(await queues[0].client.exists(queues[0].toKey('offer-capacity-v1')), 0);
        results.push({
          trial,
          mode,
          completed,
          peak,
          elapsedMs: performance.now() - started,
          p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1]
        });
      }
    }
    const report = {
      description:
        'Isolates permit scope with the same coordinator and Redis; models old whole-row permit ownership. Three clients in one process, 24 rows, capacity 2; 20ms preparation, 5ms offer, 20ms persistence. Not a production latency benchmark.',
      results
    };
    writeFileSync('scripts/issuance-benchmark/permit-scope-results.json', JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally {
    const keys = await queues[0].client.keys(`${prefix}:*`);
    if (keys.length) await queues[0].client.del(...keys);
    await Promise.all(queues.map((queue) => queue.close()));
  }
})().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
