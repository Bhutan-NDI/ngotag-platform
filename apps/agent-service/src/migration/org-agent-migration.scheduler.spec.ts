/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, no-mixed-operators */
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { OrgAgentMigrationScheduler } from './org-agent-migration.scheduler';

const MINUTE = 60 * 1000;
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';

const due = (id = 'm1', overrides = {}) => ({
  id,
  status: Status.REHEARSED,
  startedBy: USER_ID,
  scheduledFor: new Date(Date.now() - MINUTE),
  ...overrides
});

const passedReport = { passed: true, checks: [] };

const build = () => {
  const registry = { addInterval: jest.fn(), deleteInterval: jest.fn() };
  const migrationRepository = {
    findDueForStart: jest.fn().mockResolvedValue([]),
    findStalled: jest.fn().mockResolvedValue([]),
    findAwaitingWebhook: jest.fn().mockResolvedValue([]),
    findWindowEnded: jest.fn().mockResolvedValue([]),
    findRotating: jest.fn().mockResolvedValue([]),
    countInFlight: jest.fn().mockResolvedValue(0),
    tryBeginWebhookCheck: jest.fn().mockResolvedValue(true),
    tryAcquireLease: jest.fn().mockResolvedValue(true),
    getConfirmingActor: jest.fn().mockResolvedValue('owner-1'),
    recordEvent: jest.fn().mockResolvedValue(undefined)
  };
  const migrationService = { abort: jest.fn().mockResolvedValue({}) };
  const preflightService = { run: jest.fn().mockResolvedValue({ report: passedReport }) };
  const executor = {
    run: jest.fn().mockResolvedValue(undefined),
    abortInterrupted: jest.fn().mockResolvedValue(true),
    resumeCutover: jest.fn().mockResolvedValue(undefined)
  };
  const switchOverService = {
    beginSwitchOver: jest.fn().mockResolvedValue('STARTED'),
    advanceRotation: jest.fn().mockResolvedValue(undefined),
    checkWebhook: jest.fn().mockResolvedValue(undefined)
  };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const scheduler = new OrgAgentMigrationScheduler(
    registry as never,
    migrationRepository as never,
    migrationService as never,
    preflightService as never,
    executor as never,
    switchOverService as never,
    logger as never
  );
  return {
    scheduler,
    registry,
    migrationRepository,
    migrationService,
    preflightService,
    executor,
    switchOverService,
    logger
  };
};

// Lets fire-and-forget promises settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  for (const name of [
    'ORG_MIGRATION_SCHEDULER_ENABLED',
    'ORG_MIGRATION_TICK_MS',
    'ORG_MIGRATION_MAX_CONCURRENT',
    'ORG_MIGRATION_START_WINDOW_MS',
    'ORG_MIGRATION_SWITCHOVER_RETRY_MS',
    'ORG_MIGRATION_ROTATION_POLL_MS'
  ]) {
    delete process.env[name];
  }
  jest.useRealTimers();
});

describe('OrgAgentMigrationScheduler: starting moves', () => {
  it('checks again and then runs a move whose slot has arrived, as the owner who confirmed it', async () => {
    const { scheduler, executor, preflightService, migrationRepository } = build();
    migrationRepository.findDueForStart.mockResolvedValue([due()]);

    await scheduler.tick();

    expect(migrationRepository.tryAcquireLease).toHaveBeenCalledWith('m1', expect.any(Number));
    expect(preflightService.run).toHaveBeenCalledWith('m1', { keepDownloadMethod: true }, null);
    expect(executor.run).toHaveBeenCalledWith('m1', 'owner-1');
    expect(preflightService.run.mock.invocationCallOrder[0]).toBeLessThan(executor.run.mock.invocationCallOrder[0]);
  });

  it('falls back to whoever created the move when nobody is recorded as confirming it', async () => {
    const { scheduler, executor, migrationRepository } = build();
    migrationRepository.findDueForStart.mockResolvedValue([due()]);
    migrationRepository.getConfirmingActor.mockResolvedValue(null);

    await scheduler.tick();

    expect(executor.run).toHaveBeenCalledWith('m1', USER_ID);
  });

  it('leaves a move alone when another replica holds it', async () => {
    const { scheduler, executor, preflightService, migrationRepository } = build();
    migrationRepository.findDueForStart.mockResolvedValue([due()]);
    migrationRepository.tryAcquireLease.mockResolvedValue(false);

    await scheduler.tick();

    expect(preflightService.run).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('does nothing when no move is due', async () => {
    const { scheduler, executor } = build();

    await scheduler.tick();

    expect(executor.run).not.toHaveBeenCalled();
  });

  it('does not start the same move twice while it is running', async () => {
    const { scheduler, executor, migrationRepository } = build();
    executor.run.mockReturnValue(new Promise(() => undefined));
    migrationRepository.findDueForStart.mockResolvedValue([due()]);

    await scheduler.tick();
    await scheduler.tick();

    expect(executor.run).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a move ends, so the next one can start', async () => {
    const { scheduler, executor, migrationRepository } = build();
    migrationRepository.findDueForStart.mockResolvedValue([due()]);

    await scheduler.tick();
    await settle();
    await scheduler.tick();

    expect(executor.run).toHaveBeenCalledTimes(2);
  });

  it('respects the limit on moves running at once', async () => {
    process.env.ORG_MIGRATION_MAX_CONCURRENT = '1';
    const { scheduler, executor, migrationRepository } = build();
    executor.run.mockReturnValue(new Promise(() => undefined));
    migrationRepository.findDueForStart.mockResolvedValue([due('m1'), due('m2')]);

    await scheduler.tick();
    migrationRepository.countInFlight.mockResolvedValue(1);
    await scheduler.tick();

    expect(executor.run).toHaveBeenCalledTimes(1);
    expect(migrationRepository.findDueForStart).toHaveBeenCalledTimes(1);
  });

  it('counts the moves other replicas are running, not just its own', async () => {
    const { scheduler, executor, migrationRepository } = build();
    migrationRepository.countInFlight.mockResolvedValue(2);
    migrationRepository.findDueForStart.mockResolvedValue([due()]);

    await scheduler.tick();

    expect(migrationRepository.findDueForStart).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('asks only for as many moves as it has room for', async () => {
    const { scheduler, migrationRepository } = build();
    migrationRepository.countInFlight.mockResolvedValue(1);

    await scheduler.tick();

    expect(migrationRepository.findDueForStart).toHaveBeenCalledWith(expect.any(Date), 1);
  });

  it('survives a move that crashes', async () => {
    const { scheduler, executor, migrationRepository, logger } = build();
    executor.run.mockRejectedValue(new Error('boom'));
    migrationRepository.findDueForStart.mockResolvedValue([due()]);

    await scheduler.tick();
    await settle();
    await scheduler.tick();

    expect(logger.error).toHaveBeenCalled();
    expect(executor.run).toHaveBeenCalledTimes(2);
  });

  it('skips a tick that overlaps one still running', async () => {
    const { scheduler, migrationRepository } = build();
    let release: () => void;
    migrationRepository.findDueForStart.mockReturnValue(new Promise((resolve) => (release = () => resolve([]))));

    const first = scheduler.tick();
    await scheduler.tick();
    release();
    await first;

    expect(migrationRepository.findDueForStart).toHaveBeenCalledTimes(1);
  });

  it('never throws from a tick', async () => {
    const { scheduler, migrationRepository, logger } = build();
    migrationRepository.findDueForStart.mockRejectedValue(new Error('db down'));

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});

describe('OrgAgentMigrationScheduler: a missed slot', () => {
  it('cancels a move found after its start window before running any check, without freezing anything', async () => {
    const { scheduler, executor, migrationService, preflightService, migrationRepository } = build();
    migrationRepository.findDueForStart.mockResolvedValue([
      due('m1', { scheduledFor: new Date(Date.now() - 6 * 60 * MINUTE) })
    ]);

    await scheduler.tick();

    expect(migrationService.abort).toHaveBeenCalledWith('m1', 'SLOT_MISSED', null);
    expect(migrationRepository.recordEvent).toHaveBeenCalledWith('m1', {
      action: 'MOVE_CANCELLED',
      actor: null,
      detail: { reason: 'SLOT_MISSED' }
    });
    expect(preflightService.run).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('still runs a move that is a little late, within the start window', async () => {
    const { scheduler, executor, migrationService, migrationRepository } = build();
    migrationRepository.findDueForStart.mockResolvedValue([
      due('m1', { scheduledFor: new Date(Date.now() - 20 * MINUTE) })
    ]);

    await scheduler.tick();

    expect(migrationService.abort).not.toHaveBeenCalled();
    expect(executor.run).toHaveBeenCalledWith('m1', 'owner-1');
  });

  it('reads the start window from the environment', async () => {
    process.env.ORG_MIGRATION_START_WINDOW_MS = String(2 * MINUTE);
    const { scheduler, executor, migrationService, migrationRepository } = build();
    migrationRepository.findDueForStart.mockResolvedValue([
      due('m1', { scheduledFor: new Date(Date.now() - 5 * MINUTE) })
    ]);

    await scheduler.tick();

    expect(migrationService.abort).toHaveBeenCalledWith('m1', 'SLOT_MISSED', null);
    expect(executor.run).not.toHaveBeenCalled();
  });
});

describe('OrgAgentMigrationScheduler: the final checks', () => {
  const failing = (id: string) => ({
    report: {
      passed: false,
      checks: [
        { id: 'AGENT_REACHABLE', status: 'SKIPPED' },
        { id, status: 'FAIL' }
      ]
    }
  });

  it('does not freeze the org when a check fails, and tries again later', async () => {
    const { scheduler, executor, migrationService, preflightService, migrationRepository } = build();
    preflightService.run.mockResolvedValue(failing('NO_BULK_JOB'));
    migrationRepository.findDueForStart.mockResolvedValue([
      due('m1', { scheduledFor: new Date(Date.now() - 5 * MINUTE) })
    ]);

    await scheduler.tick();

    expect(executor.run).not.toHaveBeenCalled();
    expect(migrationService.abort).not.toHaveBeenCalled();
  });

  // The checks take time: the window can close while they run, which is the one place a failed check cancels.
  const failingAfter = (id: string, ms: number) => async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return failing(id);
  };

  it('cancels the move, naming the check, once the start window has passed', async () => {
    const { scheduler, executor, migrationService, preflightService, migrationRepository } = build();
    preflightService.run.mockImplementation(failingAfter('NO_BULK_JOB', 100));
    migrationRepository.findDueForStart.mockResolvedValue([
      due('m1', { scheduledFor: new Date(Date.now() - (30 * MINUTE - 50)) })
    ]);

    await scheduler.tick();

    expect(migrationService.abort).toHaveBeenCalledWith('m1', 'PREFLIGHT_FAILED:NO_BULK_JOB', null);
    expect(migrationRepository.recordEvent).toHaveBeenCalledWith('m1', {
      action: 'MOVE_CANCELLED',
      actor: null,
      detail: { reason: 'FINAL_CHECK_FAILED', check: 'NO_BULK_JOB' }
    });
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('reads the start window from the environment', async () => {
    process.env.ORG_MIGRATION_START_WINDOW_MS = String(2 * MINUTE);
    const { scheduler, migrationService, preflightService, migrationRepository } = build();
    preflightService.run.mockImplementation(failingAfter('DIDCOMM_REACHABLE', 100));
    migrationRepository.findDueForStart.mockResolvedValue([
      due('m1', { scheduledFor: new Date(Date.now() - (2 * MINUTE - 50)) })
    ]);

    await scheduler.tick();

    expect(migrationService.abort).toHaveBeenCalledWith('m1', 'PREFLIGHT_FAILED:DIDCOMM_REACHABLE', null);
  });

  it('treats checks that could not run as a failed check, and does not freeze', async () => {
    const { scheduler, executor, migrationService, preflightService, migrationRepository } = build();
    preflightService.run.mockRejectedValue(new Error('db down'));
    migrationRepository.findDueForStart.mockResolvedValue([due()]);

    await scheduler.tick();

    expect(executor.run).not.toHaveBeenCalled();
    expect(migrationService.abort).not.toHaveBeenCalled();
  });

  it('still checks the other due moves when one fails', async () => {
    const { scheduler, executor, preflightService, migrationRepository } = build();
    preflightService.run.mockResolvedValueOnce(failing('NO_BULK_JOB')).mockResolvedValueOnce({ report: passedReport });
    migrationRepository.findDueForStart.mockResolvedValue([due('m1'), due('m2')]);

    await scheduler.tick();

    expect(executor.run).toHaveBeenCalledTimes(1);
    expect(executor.run).toHaveBeenCalledWith('m2', 'owner-1');
  });
});

describe('OrgAgentMigrationScheduler: recovering stalled moves', () => {
  it.each([Status.FROZEN, Status.EXPORTING, Status.IMPORTING, Status.VERIFYING])(
    'undoes a move stuck in %s',
    async (status) => {
      const { scheduler, executor, migrationRepository } = build();
      migrationRepository.findStalled.mockResolvedValue([due('m1', { status })]);

      await scheduler.tick();

      expect(executor.abortInterrupted).toHaveBeenCalledWith('m1');
      expect(executor.resumeCutover).not.toHaveBeenCalled();
    }
  );

  it('finishes a move that was switched over but never completed', async () => {
    const { scheduler, executor, migrationRepository } = build();
    migrationRepository.findStalled.mockResolvedValue([due('m1', { status: Status.CUTOVER })]);

    await scheduler.tick();

    expect(executor.resumeCutover).toHaveBeenCalledWith('m1');
    expect(executor.abortInterrupted).not.toHaveBeenCalled();
  });

  it('leaves a stalled move to the replica that holds its lease', async () => {
    const { scheduler, executor, migrationRepository } = build();
    migrationRepository.findStalled.mockResolvedValue([due('m1', { status: Status.EXPORTING })]);
    migrationRepository.tryAcquireLease.mockResolvedValue(false);

    await scheduler.tick();

    expect(executor.abortInterrupted).not.toHaveBeenCalled();
  });

  it('does not touch a move this process is still running', async () => {
    const { scheduler, executor, migrationRepository } = build();
    executor.run.mockReturnValue(new Promise(() => undefined));
    migrationRepository.findDueForStart.mockResolvedValueOnce([due('m1')]);
    await scheduler.tick();
    migrationRepository.findStalled.mockResolvedValue([due('m1', { status: Status.EXPORTING })]);

    await scheduler.tick();

    expect(executor.abortInterrupted).not.toHaveBeenCalled();
  });

  it('looks for moves stalled for longer than the grace period', async () => {
    const { scheduler, migrationRepository } = build();

    await scheduler.tick();

    expect(migrationRepository.findStalled).toHaveBeenCalledWith(expect.any(Date), 5 * MINUTE);
  });

  it('carries on to the next stalled move when recovering one fails', async () => {
    const { scheduler, executor, migrationRepository, logger } = build();
    executor.abortInterrupted.mockRejectedValueOnce(new Error('shared agent down')).mockResolvedValue(true);
    migrationRepository.findStalled.mockResolvedValue([
      due('m1', { status: Status.EXPORTING }),
      due('m2', { status: Status.IMPORTING })
    ]);

    await scheduler.tick();

    expect(executor.abortInterrupted).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it('recovers even when starting new moves is not possible', async () => {
    const { scheduler, executor, migrationRepository } = build();
    migrationRepository.findDueForStart.mockRejectedValue(new Error('db hiccup'));
    migrationRepository.findStalled.mockResolvedValue([due('m1', { status: Status.EXPORTING })]);

    await scheduler.tick();
    await scheduler.tick();

    expect(executor.abortInterrupted).toHaveBeenCalled();
  });
});

describe('OrgAgentMigrationScheduler: ending the stabilisation window', () => {
  const ended = (id = 'm1', overrides = {}) => ({
    id,
    status: Status.STABILISING,
    stabilisationEndsAt: new Date(Date.now() - MINUTE),
    ...overrides
  });

  it('switches an org over once its window has ended, then carries straight on into the rotation', async () => {
    const { scheduler, switchOverService, migrationRepository } = build();
    migrationRepository.findWindowEnded.mockResolvedValue([ended()]);

    await scheduler.tick();

    expect(migrationRepository.tryAcquireLease).toHaveBeenCalledWith('m1', 2 * MINUTE);
    expect(switchOverService.beginSwitchOver).toHaveBeenCalledWith('m1');
    expect(switchOverService.advanceRotation).toHaveBeenCalledWith('m1');
    expect(switchOverService.beginSwitchOver.mock.invocationCallOrder[0]).toBeLessThan(
      switchOverService.advanceRotation.mock.invocationCallOrder[0]
    );
  });

  it.each(['DEFERRED', 'SKIPPED'])('does not start the rotation when the switch-over is %s', async (outcome) => {
    const { scheduler, switchOverService, migrationRepository } = build();
    migrationRepository.findWindowEnded.mockResolvedValue([ended()]);
    switchOverService.beginSwitchOver.mockResolvedValue(outcome);

    await scheduler.tick();

    expect(switchOverService.advanceRotation).not.toHaveBeenCalled();
  });

  it('leaves a migration to the replica that holds its lease', async () => {
    const { scheduler, switchOverService, migrationRepository } = build();
    migrationRepository.findWindowEnded.mockResolvedValue([ended()]);
    migrationRepository.tryAcquireLease.mockResolvedValue(false);

    await scheduler.tick();

    expect(switchOverService.beginSwitchOver).not.toHaveBeenCalled();
  });

  it('carries on to the next migration when one fails', async () => {
    const { scheduler, switchOverService, migrationRepository, logger } = build();
    migrationRepository.findWindowEnded.mockResolvedValue([ended('m1'), ended('m2')]);
    switchOverService.beginSwitchOver.mockRejectedValueOnce(new Error('boom')).mockResolvedValue('DEFERRED');

    await scheduler.tick();

    expect(switchOverService.beginSwitchOver).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it('reads the retry interval from the environment', async () => {
    process.env.ORG_MIGRATION_SWITCHOVER_RETRY_MS = '30000';
    const { scheduler, migrationRepository } = build();
    migrationRepository.findWindowEnded.mockResolvedValue([ended()]);

    await scheduler.tick();

    expect(migrationRepository.tryAcquireLease).toHaveBeenCalledWith('m1', 30000);
  });

  it('still starts and recovers moves when ending windows fails', async () => {
    const { scheduler, executor, migrationRepository } = build();
    migrationRepository.findWindowEnded.mockRejectedValue(new Error('db hiccup'));
    migrationRepository.findStalled.mockResolvedValue([due('m1', { status: Status.EXPORTING })]);

    await scheduler.tick();

    expect(executor.abortInterrupted).toHaveBeenCalledWith('m1');
  });
});

describe('OrgAgentMigrationScheduler: confirming webhooks during the window', () => {
  const waiting = (id = 'm1') => ({
    id,
    status: Status.STABILISING,
    stabilisationEndsAt: new Date(Date.now() + 60 * MINUTE)
  });

  it('checks the webhook of a migration whose window is open and whose webhook is not yet confirmed', async () => {
    const { scheduler, switchOverService, migrationRepository } = build();
    migrationRepository.findAwaitingWebhook.mockResolvedValue([waiting()]);

    await scheduler.tick();

    expect(migrationRepository.tryBeginWebhookCheck).toHaveBeenCalledWith('m1', expect.any(Date), expect.any(Date));
    expect(switchOverService.checkWebhook).toHaveBeenCalledWith('m1');
  });

  it('never takes the lease for it, so a disaster restore is not refused as busy', async () => {
    const { scheduler, migrationRepository } = build();
    migrationRepository.findAwaitingWebhook.mockResolvedValue([waiting()]);

    await scheduler.tick();

    expect(migrationRepository.tryAcquireLease).not.toHaveBeenCalled();
  });

  it('spaces its tries by a configurable time, ten minutes by default', async () => {
    const { scheduler, migrationRepository } = build();
    await scheduler.tick();
    const [now, retryBefore] = migrationRepository.findAwaitingWebhook.mock.calls[0];
    expect(now.getTime() - retryBefore.getTime()).toBe(10 * MINUTE);

    process.env.ORG_MIGRATION_WEBHOOK_RETRY_MS = String(2 * MINUTE);
    migrationRepository.findAwaitingWebhook.mockClear();
    await scheduler.tick();
    const [later, laterRetryBefore] = migrationRepository.findAwaitingWebhook.mock.calls[0];
    expect(later.getTime() - laterRetryBefore.getTime()).toBe(2 * MINUTE);
  });

  it('leaves a migration alone when another replica took this try', async () => {
    const { scheduler, switchOverService, migrationRepository } = build();
    migrationRepository.findAwaitingWebhook.mockResolvedValue([waiting()]);
    migrationRepository.tryBeginWebhookCheck.mockResolvedValue(false);

    await scheduler.tick();

    expect(switchOverService.checkWebhook).not.toHaveBeenCalled();
  });

  it('carries on to the next migration, and the rest of the pass, when one check fails', async () => {
    const { scheduler, switchOverService, migrationRepository, logger } = build();
    migrationRepository.findAwaitingWebhook.mockResolvedValue([waiting('m1'), waiting('m2')]);
    switchOverService.checkWebhook.mockRejectedValueOnce(new Error('db down'));
    migrationRepository.findWindowEnded.mockResolvedValue([
      { id: 'm3', status: Status.STABILISING, stabilisationEndsAt: new Date(Date.now() - MINUTE) }
    ]);

    await scheduler.tick();

    expect(switchOverService.checkWebhook).toHaveBeenCalledWith('m2');
    expect(switchOverService.beginSwitchOver).toHaveBeenCalledWith('m3');
    expect(logger.error).toHaveBeenCalled();
  });

  it('survives the lookup failing', async () => {
    const { scheduler, migrationRepository, switchOverService } = build();
    migrationRepository.findAwaitingWebhook.mockRejectedValue(new Error('db down'));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(switchOverService.checkWebhook).not.toHaveBeenCalled();
  });
});

describe('OrgAgentMigrationScheduler: watching rotations', () => {
  const rotating = (id = 'm1', overrides = {}) => ({
    id,
    status: Status.ROTATING,
    purgedAt: null,
    rotationJobId: null,
    ...overrides
  });

  it('drives a rotation that still has purging or starting to do on a short lease', async () => {
    const { scheduler, switchOverService, migrationRepository } = build();
    migrationRepository.findRotating.mockResolvedValue([rotating()]);

    await scheduler.tick();

    expect(migrationRepository.tryAcquireLease).toHaveBeenCalledWith('m1', 2 * MINUTE);
    expect(switchOverService.advanceRotation).toHaveBeenCalledWith('m1');
  });

  it('only looks in now and then once the rotation is running', async () => {
    const { scheduler, migrationRepository } = build();
    migrationRepository.findRotating.mockResolvedValue([
      rotating('m1', { purgedAt: new Date(), rotationJobId: 'rotate-all:x' })
    ]);

    await scheduler.tick();

    expect(migrationRepository.tryAcquireLease).toHaveBeenCalledWith('m1', 10 * MINUTE);
  });

  it('reads the polling interval from the environment', async () => {
    process.env.ORG_MIGRATION_ROTATION_POLL_MS = '60000';
    const { scheduler, migrationRepository } = build();
    migrationRepository.findRotating.mockResolvedValue([
      rotating('m1', { purgedAt: new Date(), rotationJobId: 'rotate-all:x' })
    ]);

    await scheduler.tick();

    expect(migrationRepository.tryAcquireLease).toHaveBeenCalledWith('m1', 60000);
  });

  it('leaves a rotation to the replica that holds its lease', async () => {
    const { scheduler, switchOverService, migrationRepository } = build();
    migrationRepository.findRotating.mockResolvedValue([rotating()]);
    migrationRepository.tryAcquireLease.mockResolvedValue(false);

    await scheduler.tick();

    expect(switchOverService.advanceRotation).not.toHaveBeenCalled();
  });

  it('carries on to the next rotation when one fails', async () => {
    const { scheduler, switchOverService, migrationRepository, logger } = build();
    migrationRepository.findRotating.mockResolvedValue([rotating('m1'), rotating('m2')]);
    switchOverService.advanceRotation.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

    await scheduler.tick();

    expect(switchOverService.advanceRotation).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it('still ends windows when watching rotations fails', async () => {
    const { scheduler, switchOverService, migrationRepository } = build();
    migrationRepository.findRotating.mockRejectedValue(new Error('db hiccup'));
    migrationRepository.findWindowEnded.mockResolvedValue([{ id: 'm9', status: Status.STABILISING }]);

    await scheduler.tick();

    expect(switchOverService.beginSwitchOver).toHaveBeenCalledWith('m9');
  });
});

describe('OrgAgentMigrationScheduler: lifecycle', () => {
  it('ticks on an interval it registers, and stops it on shutdown', async () => {
    jest.useFakeTimers();
    process.env.ORG_MIGRATION_TICK_MS = '1000';
    const { scheduler, registry, migrationRepository } = build();

    scheduler.onModuleInit();
    expect(registry.addInterval).toHaveBeenCalledWith('org-agent-migration-tick', expect.anything());
    await jest.advanceTimersByTimeAsync(2500);

    expect(migrationRepository.findStalled).toHaveBeenCalledTimes(2);
    expect(migrationRepository.findDueForStart).toHaveBeenCalledTimes(2);
    expect(migrationRepository.findWindowEnded).toHaveBeenCalledTimes(2);
    expect(migrationRepository.findRotating).toHaveBeenCalledTimes(2);

    scheduler.onModuleDestroy();
    expect(registry.deleteInterval).toHaveBeenCalledWith('org-agent-migration-tick');
    clearInterval(registry.addInterval.mock.calls[0][1]);
  });

  it('does not start when it is switched off', () => {
    process.env.ORG_MIGRATION_SCHEDULER_ENABLED = 'false';
    const { scheduler, registry } = build();

    scheduler.onModuleInit();

    expect(registry.addInterval).not.toHaveBeenCalled();
  });

  it('shuts down quietly when it never started', () => {
    const { scheduler, registry } = build();
    registry.deleteInterval.mockImplementation(() => {
      throw new Error('no such interval');
    });

    expect(() => scheduler.onModuleDestroy()).not.toThrow();
  });
});
