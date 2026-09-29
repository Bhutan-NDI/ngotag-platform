require('ts-node/register/transpile-only');
const Queue = require('bull');
const { fork } = require('child_process');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const fs = require('fs');
const assert = require('assert/strict');
const path = require('path');
const { localRedis } = require('../../apps/issuance/test/local-redis.ts');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function percentile(values, q) {
  const sorted = values.map(Number).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
async function trial(mode, repeat) {
  const prefix = `issuance-benchmark-${randomUUID()}`;
  const queue = new Queue('bulk-issuance', { redis: localRedis(), prefix });
  const children = [];
  const reports = [];
  try {
    await queue.isReady();
    const ready = Array.from(
      { length: 3 },
      () =>
        new Promise((resolve, reject) => {
          const child = fork(path.join(__dirname, 'worker.cjs'), [mode, prefix], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: { ...process.env, ISSUANCE_GLOBAL_CONCURRENCY: '8', ISSUANCE_WORKER_CONCURRENCY: '8' }
          });
          children.push(child);
          child.once('error', reject);
          child.once('exit', (code) => {
            if (code !== 0) reject(Error('Worker failed'));
          });
          child.on('message', (msg) => {
            if (msg.ready) resolve();
            else reports.push(msg);
          });
        })
    );
    await Promise.race([
      Promise.all(ready),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('Worker startup timeout')), 30000);
        timer.unref();
      })
    ]);
    const start = performance.now();
    await queue.addBulk(Array.from({ length: 120 }, (_, id) => ({ data: { id: String(id), enqueuedAt: Date.now() } })));
    let completedAt;
    while (true) {
      const completed = await queue.getCompletedCount();
      const finished = await queue.client.scard(`${prefix}:finished`);
      if (completed === 120 && completedAt === undefined) completedAt = performance.now() - start;
      if (finished === 120 && completed === 120) break;
      if (performance.now() - start > 15000) throw Error('Benchmark did not complete');
      await sleep(10);
    }
    const elapsed = performance.now() - start;
    await sleep(30);
    const ages = await queue.client.lrange(`${prefix}:queue-age`, 0, -1);
    const durations = await queue.client.lrange(`${prefix}:service-ms`, 0, -1);
    const result = {
      mode,
      repeat,
      replicas: 3,
      workerConcurrency: 8,
      globalBudget: mode === 'after' ? 8 : null,
      jobs: 120,
      actualPeak: Number(await queue.client.get(`${prefix}:actual-peak`)),
      prematureCompletions: Number((await queue.client.get(`${prefix}:premature`)) || 0),
      queueCompletedMs: completedAt,
      actualCompletedMs: elapsed,
      throughput: (120 / elapsed) * 1000,
      queueAgeP95Ms: percentile(ages, 0.95),
      serviceP95Ms: percentile(durations, 0.95),
      failedJobs: await queue.getFailedCount()
    };
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve, reject) => {
            child.once('exit', (code) => (code === 0 ? resolve() : reject(Error('Worker cleanup failed'))));
            child.send('stop');
          })
      )
    );
    assert.equal(reports.length, 3);
    assert.equal(result.failedJobs, 0);
    if (mode === 'after') {
      assert(result.actualPeak > 0 && result.actualPeak <= 8);
      assert.equal(result.prematureCompletions, 0);
    } else {
      assert(result.prematureCompletions > 0);
    }
    result.workerCpuMs = reports.reduce((a, r) => a + r.cpuMs, 0);
    result.workerPeakRssBytes = reports.map((r) => r.peakRss);
    return result;
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    const keys = await queue.client.keys(`${prefix}:*`);
    if (keys.length) await queue.client.del(...keys);
    await queue.close();
  }
}
(async () => {
  const results = [];
  for (let repeat = 0; repeat < 3; repeat++)
    for (const mode of repeat % 2 ? ['after', 'before'] : ['before', 'after']) {
      const result = await trial(mode, repeat);
      results.push(result);
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  fs.writeFileSync(
    path.join(__dirname, 'results.json'),
    JSON.stringify(
      {
        description: 'Synthetic timer workload; proves queue accounting and concurrency, not database CPU savings',
        node: process.version,
        arch: process.arch,
        bull: '4.16.5',
        redis: '7.2.5',
        results
      },
      null,
      2
    ) + '\n'
  );
})().catch(() => {
  process.stderr.write('Synthetic benchmark failed; do not interpret partial results\n');
  process.exitCode = 1;
});
