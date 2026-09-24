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
- A shared Redis budget covers actual offer dispatch in both direct paths and
  bulk rows. Preparation, email delivery and result persistence do not hold offer
  permits. A separate local queue bounds whole-row processing; the row guard stays
  held throughout preparation, dispatch and persistence. Other applications calling an
  agent directly, and later DIDComm exchanges, are outside this budget.
- A local limiter bounds Redis contenders, and a finite pending-admission limit
  bounds each local waiting list. Expired waiters are removed immediately, freeing
  their queue positions even while admitted work remains active. Local offer
  contenders are limited to the smaller of the worker and global budgets. Redis
  contention retries back off from 1 ms to 50 ms and obey the admission deadline. Redis atomically enforces the shared budget across
  participating processes using the same Bull queue namespace.
- Capacity-wait expiry includes local waiting. Expired work cannot dispatch later.
  Once admitted, the timer is cancelled: a timeout cannot safely cancel a remote
  credential operation. Its promise must settle before the permit is released.
- Batch completion counts distinct **persisted** rows in Redis, including persisted
  failures. Duplicate row completion does not increment the count. Final file
  status is persisted before the completion notification. Notification delivery
  remains asynchronous; this is not an exactly-once notification protocol.
- Unexpected row/admission/persistence errors mark an active file in the owning
  organization `PROCESS_INTERRUPTED` before emitting the existing error event.
  They do not count an unpersisted or still-owned row as complete and do not clear
  its guard. Other rows can still be running: interruption is not cancellation.
  Reconcile uncertain outcomes before retrying. If the database is unavailable,
  the job still fails and a diagnostic is logged; file persistence cannot be
  guaranteed during that outage.
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

| Setting                       | Default | Accepted range | Meaning                                                |
| ----------------------------- | ------: | -------------: | ------------------------------------------------------ |
| `ISSUANCE_GLOBAL_CONCURRENCY` |       8 |          1–128 | Shared permits for actual offers only                  |
| `ISSUANCE_WORKER_CONCURRENCY` |       8 |          1–128 | Bull handlers and whole rows per process               |
| `ISSUANCE_MAX_PENDING`        |    1000 |        1–10000 | Pending admissions per local row/offer queue           |
| `ISSUANCE_CAPACITY_WAIT_MS`   |  300000 |      1–3600000 | Bulk admission deadline; interactive waits are shorter |

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

Unactivated reservations expire after 30 seconds using Redis server time and are
reclaimed on subsequent acquisition. Dispatch requires an acknowledged atomic
activation of the same unexpired owner, so a delayed worker cannot use a reclaimed
reservation. Active permits and uncertain-row guards deliberately **do not expire**.
Reusing an active slot because a timer elapsed could overlap a remote request still
executing. Normal completion releases the owner; cleanup retries transient Redis
failures three times without replaying the operation. A crash before dispatch
activation or after offer cleanup no longer strands global capacity during unrelated
row work. A killed worker after activation, or exhausted cleanup retries, can still
leave state behind until operators reconcile it. Legacy numeric owners are retained
conservatively during upgrades. This is an
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

The latency follow-up scoped suite has **39 passing tests** on Node 20.19.4. It covers pending promises,
failure propagation, persistence ordering, shared budgets, separate row/offer scopes, expiring reservations, cleanup retries, admission
expiry without late dispatch, tenant/UUID isolation, duplicate completion, guarded
retries and independent email DTOs. The issuance build and targeted lint pass.

The original PR repository-wide comparison used the same locked root dependencies and Node
runtime. Untouched `develop` has 19 failed suites / five failed assertions; the
candidate has the **same** failing suites and assertions, with 33 additional passing
tests. No unrelated test repair or dependency/lockfile refresh is included. A
separate PR workflow builds issuance and runs its tests, three-process checks and
crash test without cloud credentials or deployment steps.

The original PR synthetic benchmark uses real Bull 4.16.5, Redis 7.2.5 and three separate Node
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
its active-offer permit remains reserved, and its row cannot be retried blindly.
Additional kills during preparation and persistence leave no global offer permit
behind, while retaining row guards and preventing automatic replay.

Batch completion/queue-age increases in the timer fixture are expected: the old
path overlaps almost all timers and reports success before they finish. Worker CPU
and memory measurements are included, but they are not RDS savings measurements.
Before sizing production, compare equivalent traffic: queue age and completion time,
throughput, errors, active work, application CPU/memory, and database CPU/AAS and
latency. No account-specific information is published in these results.

## Follow-up latency measurement

The additional [permit-scope fixture](../scripts/issuance-benchmark/permit-scope.cjs)
compares whole-row and offer-only ownership using the same updated coordinator and
isolated Redis. Three clients in one process submit 24 rows with a global cap of two;
each row simulates 20 ms preparation, 5 ms offer and 20 ms persistence. Alternating
three trials, median p95 row latency falls from 620.15 ms to 134.58 ms (78.3%) and
median batch time from 621.68 ms to 137.02 ms (78.0%). All 24 rows complete and actual
offer overlap stays at two. [Raw results](benchmarks/issuance-permit-scope.json).

An initial experiment with fixed 50 ms acquisition polling showed essentially no
improvement (approximately 621 ms p95 in both modes). Bounded local contention and
early exponential retry reduce that artificial wait. This fixture isolates the
mechanism; it neither compares released production versions nor measures network,
cryptography, database or email latency. It does not demonstrate a 99.9% reduction.

The follow-up also reran the [three-process regression](benchmarks/issuance-work-latency-followup.json):
all three candidate trials stayed at eight active operations with zero premature
completions and zero failed jobs. The cap still increases total batch time compared
with the unsafe unbounded baseline. [Three-phase crash results](benchmarks/issuance-crash-phases.json).

Whole-row preparation and persistence are now bounded **per process**, not by the
global offer budget: up to worker concurrency times replica count can run. This
improves overlap but can increase platform database/email pressure relative to the
initial whole-row cap. Keep the existing budgets until representative production
measurements justify changes. Credo dispatch remains globally bounded; no SQL count
or database-size reduction is claimed by this follow-up.

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
RUN_ISSUANCE_REDIS_TESTS=1 pnpm exec jest --runInBand apps/issuance/src/issuance-admission.queue.spec.ts apps/issuance/src/issuance.processor.spec.ts apps/issuance/src/issuance-work.coordinator.spec.ts apps/issuance/src/issuance.service.lifecycle.spec.ts
node scripts/issuance-benchmark/run.cjs
node scripts/issuance-benchmark/crash-check.cjs
node scripts/issuance-benchmark/permit-scope.cjs
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

## Interactive request admission deadline

Interactive offer requests now carry an internal `issuance-admission-deadline` NATS
header from the API gateway's existing request context. The gateway creates it from
server receipt time; public client headers and payloads cannot extend it. The three
interactive issuance entrypoints validate it before preparation and the coordinator
checks the remaining monotonic budget again immediately before the first dispatch.

- The gateway admission budget is ten seconds, including authentication/guard time,
  NATS delivery, preparation and waiting. Expired or malformed deadlines fail before
  the first dispatch; distant peer deadlines are clamped to the local ten-second maximum.
- First dispatch admits the request, including its later recipients. Execution and
  email time do not make later recipients expire against the original admission
  deadline. This state is isolated to that request; it cannot admit another request.
- Direct multi-recipient requests schedule at most the smaller of the worker and
  global budgets at once. Recipients waiting within that request do not start
  their capacity-wait timer until scheduled. Existing per-recipient results and
  ordering are preserved.
- Every offer, including later recipients, still obtains its own Redis permit and
  has at most a one-second capacity wait (or a lower `ISSUANCE_CAPACITY_WAIT_MS`).
  Before first dispatch, the original request deadline also applies. Preparation,
  email and persistence stay outside permits; bulk keeps its existing wait budget.
  Admission is not a reservation for the whole array: other traffic or downstream
  failures can still produce partial results. Multi-recipient requests are not
  atomic or automatically replayable.
- Bulk rows retain `ISSUANCE_CAPACITY_WAIT_MS` and their durable job lifecycle. No
  execution timer releases a permit while a downstream side effect is still active.
- A legacy internal sender without a deadline receives a ten-second budget at the
  receiving service; this cannot account for time spent before that service. Roll
  out gateway and issuance together using the previously documented drain procedure.
  Cross-host absolute deadline propagation requires synchronized clocks.

The observed ingress idle timeout is sixty seconds. A ten-second **latest admission**
budget for the first offer leaves time for downstream work, but is not a guarantee
that every recipient completes within sixty seconds. Already-dispatched requests can remain uncertain on connection loss;
no automatic replay was added. Shorter admission improves overload behavior, not the
latency of successful cryptography, database work or user-wallet interaction. It can
increase overload responses versus a long queue; measure successes and failures
separately and size capacity to keep expected traffic within its latency target.

Focused tests exercise expired requests before preparation, expiry during preparation
and queueing, original-deadline propagation, bulk compatibility, and active offers
remaining owned after their admission deadline passes. The API gateway and issuance
builds are both validated. This change introduces no public request schema or database
migration and adds no infrastructure.
