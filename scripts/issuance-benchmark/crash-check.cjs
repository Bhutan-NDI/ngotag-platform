require('ts-node/register/transpile-only');
const Queue = require('bull');
const { fork } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const assert = require('assert/strict');
const { localRedis } = require('../../apps/issuance/test/local-redis.ts');
const { IssuanceWorkCoordinator } = require('../../apps/issuance/src/issuance-work.coordinator.ts');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  for (const mode of ['crash', 'crash-prepare', 'crash-persist']) {
    const prefix = `issuance-benchmark-${randomUUID()}`;
    const queue = new Queue('bulk-issuance', {
      redis: localRedis(),
      prefix,
      settings: { maxStalledCount: 0, lockDuration: 500, lockRenewTime: 200, stalledInterval: 250 }
    });
    let child;
    try {
      await queue.isReady();
      child = fork(path.join(__dirname, 'worker.cjs'), [mode, prefix], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, ISSUANCE_GLOBAL_CONCURRENCY: '8' }
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('startup timeout')), 15000);
        child.once('error', reject);
        child.on('message', (msg) => {
          if (msg.ready) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const job = await queue.add({ id: 'crash-row', enqueuedAt: Date.now() });
      for (
        let i = 0;
        Number(await queue.client.get(`${prefix}:${mode === 'crash' ? 'actual-active' : 'crash-ready'}`)) !== 1;
        i++
      ) {
        if (i > 200) throw Error('work did not start');
        await sleep(10);
      }
      const exit = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exit;
      let replayed = 0;
      queue.process(1, async () => {
        replayed++;
        return true;
      });
      for (let i = 0; (await job.getState()) !== 'failed'; i++) {
        if (i > 300) throw Error('stalled job did not fail');
        await sleep(10);
      }
      assert.equal(replayed, 0);
      assert.equal(await queue.client.hlen(queue.toKey('offer-capacity-v1')), mode === 'crash' ? 2 : 0);
      if (mode === 'crash') assert.equal(await queue.client.ttl(queue.toKey('offer-capacity-v1')), -1);
      const coordinator = new IssuanceWorkCoordinator(queue);
      await assert.rejects(
        coordinator.bulkRow('synthetic', 'file', 'crash-row', async () => {
          replayed++;
          return true;
        }),
        /reconcile/
      );
      assert.equal(replayed, 0);
      process.stdout.write(
        JSON.stringify({
          phase: mode,
          stalledJobFailed: true,
          automaticReplays: replayed,
          orphanPermitRetained: mode === 'crash',
          unsafeRetryBlocked: true
        }) + '\n'
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const keys = await queue.client.keys(`${prefix}:*`);
      if (keys.length) await queue.client.del(...keys);
      await queue.close();
    }
  }
})().catch(() => {
  process.stderr.write('Crash fixture failed\n');
  process.exitCode = 1;
});
