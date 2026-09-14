# Issuance work lifecycle and concurrency

The bulk processor previously returned while `processIssuanceData()` was still
running. Bull could mark a job complete and fetch another, so its concurrency did
not bound issuance work. The producer's `p-limit` wrapped already-created job
objects and had no effect on the later work. A process-local counter also marked
the last **started** row as the last row, and could not combine progress across
worker replicas.

## Behavior

- The processor awaits issuance and result persistence. A persisted unsuccessful
  result fails its job; exceptions propagate. It does not automatically replay a
  side-effecting operation.
- A shared Redis budget covers bulk row processing and both direct offer dispatch
  paths in the issuance service. Bulk calls reuse their existing permit for nested
  offers, avoiding a double-acquisition deadlock. Other applications calling an
  agent directly, and later DIDComm exchanges, are outside this budget.
- A local limiter bounds Redis contenders, and a finite pending-admission limit
  bounds the local waiting list. Redis atomically enforces the shared budget across
  participating processes using the same Bull queue namespace.
- Capacity-wait expiry includes local waiting. Expired work cannot dispatch later.
  Once admitted, the timer is cancelled: a timeout cannot safely cancel a remote
  credential operation. Its promise must settle before the permit is released.
- Batch completion counts distinct **persisted** rows in Redis, including persisted
  failures. Duplicate row completion does not increment the count. Final file
  status is persisted before the completion notification. Notification delivery
  remains asynchronous; this is not an exactly-once notification protocol.
- A successful stored row is not issued again. A row guard prevents simultaneous
  processing or replay after an uncertain dispatch outcome. UUID case variations
  share the same guard. Pre-dispatch failures can use the explicit retry flow;
  post-dispatch failures require reconciliation first, including email failures
  after an offer was created. The retry API rejects guarded rows before enqueueing.
- The producer retains its batching and inter-batch pacing. It no longer pretends
  to limit work by awaiting job objects or logs the queued credential payloads.
  Background enqueue failures have rejection handlers while preserving the
  asynchronous API response.
- Direct offer loops no longer add the old 500 ms sleeps; actual dispatch is now
  budgeted. Concurrent emails use separate DTOs so recipients and attachments
  cannot overwrite one another through shared mutable state.

This does not reduce the SQL work per credential or certify a database resize.
Its primary benefit is controlled burst size and accurate lifecycle/failure tracking.

## Configuration

Set environment variables before starting workers. All participating replicas must
use the same global budget and Redis namespace.

| Setting                       | Default | Accepted range | Meaning                                                  |
| ----------------------------- | ------: | -------------: | -------------------------------------------------------- |
| `ISSUANCE_GLOBAL_CONCURRENCY` |       8 |          1–128 | Shared permits for bulk rows and direct offers           |
| `ISSUANCE_WORKER_CONCURRENCY` |       8 |          1–128 | Bull handlers and local contenders per process           |
| `ISSUANCE_MAX_PENDING`        |    1000 |        1–10000 | Additional local admissions waiting for a contender slot |
| `ISSUANCE_CAPACITY_WAIT_MS`   |  300000 |      1–3600000 | Admission deadline; not an execution timeout             |

Malformed, blank, zero, fractional and oversized settings fail rather than silently
falling back. A full admission list or expired wait rejects before dispatch.
Conflicting global budgets fail closed while permits are held. Drain workers before
changing the budget; do not intentionally run mixed configurations.

**Eight is a configurable starting budget, not a measured production SLO.** Lower
concurrency can increase queue age and batch completion time. Validate normal peaks,
bulk completion deadlines, email-provider limits and agent load before rollout.
The 500 ms removal benefits an uncontended direct path; it does not promise lower
end-to-end latency for every queued row.

## Retry, crash and Redis requirements

Bull jobs use one attempt, the processor calls `discard()`, and this queue disables
automatic stalled-job replay (`maxStalledCount: 0`). Do not add a Bull execution
`timeout`: Bull cannot cancel the downstream offer when that timer fires.

Permits and uncertain-row guards deliberately **do not expire**. Reusing a slot
because a timer elapsed could overlap a remote request that is still executing.
Normal completion releases owned state. A killed worker or failed cleanup can leave
state behind, reducing available capacity until operators reconcile it. This is an
explicit availability tradeoff; alert on old active jobs, admission failures,
stalled/failed jobs, retained permits and queue age.

This mechanism requires one authoritative, appropriately persistent Redis keyspace
with no eviction of coordination keys. Namespace changes, lost Redis data or
failover that loses acknowledged state can invalidate coordination. It is not a
claim of exactly-once execution across data loss, arbitrary external retries or
uncancelled remote operations after transport failures. Redis errors fail closed;
there is no process-local fallback that silently exceeds the shared budget.

Recovery must be deliberate:

1. Stop admission and drain/identify the affected worker processes through an
   approved operational procedure. Establish that their downstream requests have
   stopped before reclaiming permits. Do not clear live owners or expire all keys.
2. For a guarded row, reconcile its existing offer and stored file status. If an
   offer exists, complete delivery/reconciliation without creating another offer.
   If no offer exists and the prior operation has stopped, an approved cleanup of
   that specific guard permits the explicit retry flow. When the outcome remains
   unknown, keep the guard.
3. Reconcile file status/notifications separately from credential creation. A
   notification failure does not justify issuing another credential.

State uses `queue.toKey()` with `offer-capacity-v1`, `issuance-row-v1-<digest>` and
`issuance-completed-v1-<batch>`. The row digest is SHA-256 of the JSON array of
trimmed, lowercase organization/file/row UUIDs. State contains ownership/counting
metadata, not credential payloads. Completed batch sets expire after seven days;
uncompleted batch state requires owner-led cleanup after reconciliation.

An approved rollout must quiesce the old fire-and-forget workers and their detached
work before starting the new workers. A rolling mixture cannot establish the cap.
Rollback also requires draining work: returning immediately to the old worker would
restore premature completion and bypass these guards. This PR deploys nothing.

## Tests and measurements

The scoped suite has **33 passing tests** on Node 24.21.0. It covers pending promises,
failure propagation, persistence ordering, shared budgets, nested offers, admission
expiry without late dispatch, tenant/UUID isolation, duplicate completion, guarded
retries and independent email DTOs. The issuance build and targeted lint pass.

The repository-wide comparison used the same locked root dependencies and Node
runtime. Untouched `develop` has 19 failed suites / five failed assertions; the
candidate has the **same** failing suites and assertions, with 33 additional passing
tests. No unrelated test repair or dependency/lockfile refresh is included. A
separate PR workflow builds issuance and runs its tests, three-process checks and
crash test without cloud credentials or deployment steps.

The synthetic benchmark uses real Bull 4.16.5, Redis 7.2.5 and three separate Node
worker processes. Each run submits 120 rows whose fake downstream work waits 40 ms.
Three repetitions alternate baseline/candidate order. Baseline reproduces the
unawaited handler; candidate runs the actual processor and coordinator with a shared
budget of eight. Both have eight registered handlers per worker to isolate the
lifecycle/budget correction. This is **not** a representative database workload.

Medians of the three trials (120 rows per run):

| Metric                     |    Before | Candidate |
| -------------------------- | --------: | --------: |
| Peak overlapping work      |       120 |         8 |
| Premature completions      |       120 |         0 |
| Actual batch completion    | 110.78 ms | 817.87 ms |
| p95 queue age              |     54 ms |    766 ms |
| p95 simulated service time |  53.15 ms |  43.69 ms |
| Worker CPU time, summed    | 414.19 ms | 656.79 ms |

The cap reduces overlap by 93.3% in this fixture, at the visible cost of a longer
batch and additional coordination CPU. The small service-time improvement in a
40 ms timer fixture is not evidence of a database or production latency gain.

Final raw results are in [issuance-work.json](benchmarks/issuance-work.json). Every
candidate run must have at most eight overlapping operations, zero premature
completions and zero failed jobs. The baseline must reproduce premature completion.
The crash test kills one owned local worker and verifies its job fails without replay,
its permit remains reserved, and its row cannot be retried blindly.

Batch completion/queue-age increases in the timer fixture are expected: the old
path overlaps almost all timers and reports success before they finish. Worker CPU
and memory measurements are included, but they are not RDS savings measurements.
Before sizing production, compare equivalent traffic: queue age and completion time,
throughput, errors, active work, application CPU/memory, and database CPU/AAS and
latency. No account-specific information is published in these results.

## Reproduce locally

Use Node 24.21.0 and pnpm 9.15.3. The Dockerfile installs root manifests before copying
workspace sources. Follow that same sequence in a temporary dependency directory:

```sh
mkdir -p /tmp/issuance-test-dependencies
cp package.json pnpm-lock.yaml pnpm-workspace.yaml /tmp/issuance-test-dependencies/
pnpm --dir /tmp/issuance-test-dependencies install --frozen-lockfile --ignore-scripts
# In a fresh checkout without node_modules:
ln -s /tmp/issuance-test-dependencies/node_modules node_modules
pnpm exec prisma generate --schema=libs/prisma-service/prisma/schema.prisma
pnpm run build issuance
docker run --rm -d --name codex-issuance-p2-redis -p 127.0.0.1::6379 redis:7.2.5
RUN_ISSUANCE_REDIS_TESTS=1 pnpm exec jest --runInBand apps/issuance/src/issuance.processor.spec.ts apps/issuance/src/issuance-work.coordinator.spec.ts apps/issuance/src/issuance.service.lifecycle.spec.ts
node scripts/issuance-benchmark/run.cjs
node scripts/issuance-benchmark/crash-check.cjs
```

Wait for Redis readiness before testing. Fixtures reject non-local Docker contexts
and require that exact dedicated container's localhost port. They modify only unique
fixture namespaces and never accept a production Redis URL. Stop this disposable
container after testing. Do not use its name for an existing Redis service.

A full-source `pnpm install --frozen-lockfile` currently fails on existing workspace
manifest/lockfile mismatches in `develop`; the manifest-first installation above
matches the Docker build without rewriting lockfiles or relaxing frozen installation.

Bull's [reference](https://github.com/OptimalBits/bull/blob/v4.16.5/REFERENCE.md)
describes promise completion, per-worker concurrency, retries and stalled jobs.
