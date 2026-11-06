// Disposable synthetic worker. Never loads application configuration or credentials.
require('ts-node/register/transpile-only');
const Queue = require('bull');
const Module = require('module');
const { performance } = require('perf_hooks');
const { localRedis } = require('../../apps/issuance/test/local-redis.ts');
const { IssuanceWorkCoordinator } = require('../../apps/issuance/src/issuance-work.coordinator.ts');
const servicePath = require.resolve('../../apps/issuance/src/issuance.service.ts');
const serviceModule = new Module(servicePath);
serviceModule.exports = { IssuanceService: class {} };
serviceModule.loaded = true;
require.cache[servicePath] = serviceModule;
const { BulkIssuanceProcessor } = require('../../apps/issuance/src/issuance.processor.ts');
const [mode, prefix] = process.argv.slice(2);
if (
  !['before', 'after', 'crash', 'crash-prepare', 'crash-persist'].includes(mode) ||
  !/^issuance-benchmark-[a-f0-9-]+$/.test(prefix)
)
  throw Error('Invalid fixture arguments');
const queue = new Queue('bulk-issuance', {
  redis: localRedis(),
  prefix,
  settings: {
    maxStalledCount: 0,
    ...(mode.startsWith('crash') ? { lockDuration: 500, lockRenewTime: 200, stalledInterval: 250 } : {})
  }
});
const coordinator = new IssuanceWorkCoordinator(queue);
const cpuStart = process.cpuUsage();
let peakRss = process.memoryUsage().rss;
async function operation(data) {
  const start = performance.now();
  await queue.client.eval(
    "local n=redis.call('INCR',KEYS[1]);local p=tonumber(redis.call('GET',KEYS[2]) or '0');if n>p then redis.call('SET',KEYS[2],n) end;return n",
    2,
    `${prefix}:actual-active`,
    `${prefix}:actual-peak`
  );
  await queue.client.rpush(`${prefix}:queue-age`, String(Date.now() - data.enqueuedAt));
  await new Promise((resolve) => setTimeout(resolve, mode === 'crash' ? 60000 : 40));
  await queue.client.decr(`${prefix}:actual-active`);
  await queue.client.rpush(`${prefix}:service-ms`, String(performance.now() - start));
  await queue.client.sadd(`${prefix}:finished`, data.id);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  return true;
}
const service = {
  processIssuanceData: (data) =>
    mode === 'before'
      ? operation(data)
      : coordinator.bulkRow('synthetic', 'file', data.id, async () => {
          if (mode === 'crash-prepare') {
            await queue.client.set(`${prefix}:crash-ready`, '1');
            await new Promise((resolve) => setTimeout(resolve, 60000));
          }
          const result = await coordinator.offer(() => operation(data));
          if (mode === 'crash-persist') {
            await queue.client.set(`${prefix}:crash-ready`, '1');
            await new Promise((resolve) => setTimeout(resolve, 60000));
          }
          return result;
        })
};
const processor = new BulkIssuanceProcessor(service);
queue.process(
  8,
  mode === 'before'
    ? async (job) => {
        void service.processIssuanceData(job.data).catch(() => process.exit(2));
      }
    : (job) => processor.issueCredential(job)
);
queue.on('completed', async (job) => {
  if (!(await queue.client.sismember(`${prefix}:finished`, job.data.id)))
    await queue.client.incr(`${prefix}:premature`);
});
queue.on('error', () => process.exit(3));
queue.isReady().then(() => process.send({ ready: true }));
process.on('message', async (message) => {
  if (message === 'stop') {
    await queue.close();
    const cpu = process.cpuUsage(cpuStart);
    process.send({ cpuMs: (cpu.user + cpu.system) / 1000, peakRss });
    process.disconnect();
  }
});
