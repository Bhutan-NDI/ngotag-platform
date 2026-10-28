/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-explicit-any, prefer-destructuring, no-mixed-operators */
/**
 * The end of the stabilisation window against an in-memory world: the migration row, the relay, the shared agent that
 * purges and the dedicated agent that rotates. The state machine is the real one.
 */
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { MigrationAgentError } from './migration-agent.client';
import { canTransition } from './org-agent-migration.state-machine';
import { OrgAgentMigrationSwitchOverService, rotationSettled } from './org-agent-migration.switch-over.service';

const MIGRATION_ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';
const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const MINUTE = 60 * 1000;

const SHARED = { endpoint: 'https://shared.example.com', token: 'base-token' };
const DEDICATED = { endpoint: 'https://admin.org.example.com', token: 'root-token' };

const counts = (overrides = {}) => ({
  total: 10,
  pending: 0,
  retrying: 0,
  failed: 0,
  waiting: 0,
  stale: 0,
  refused: 0,
  updated: 10,
  ...overrides
});
const rotation = (status: 'idle' | 'running' | 'completed', countOverrides = {}) => ({
  job: {
    status,
    startedAt: '2026-10-23T08:00:00.000Z',
    ...('completed' === status ? { completedAt: '2026-10-23T09:00:00.000Z' } : {})
  },
  counts: counts(countOverrides)
});

const buildWorld = (rowOverrides: Record<string, unknown> = {}) => {
  const world = {
    row: {
      id: MIGRATION_ID,
      orgId: ORG_ID,
      status: Status.STABILISING as string,
      tenantId: 'tenant-1',
      preflight: { passed: true, checks: [{ id: 'WEBHOOK_DELIVERS', status: 'PASS' }] },
      stabilisationEndsAt: new Date(Date.now() - MINUTE),
      purgedAt: null as Date | null,
      rotationJobId: null as string | null,
      rotation: null as unknown,
      error: null as string | null,
      ...rowOverrides
    } as Record<string, any>,
    relay: { mode: 'FORWARD', target: 'https://didcomm.org.example.com' } as Record<string, unknown> | undefined,
    rotationStatus: rotation('running', { pending: 10, updated: 0 }) as ReturnType<typeof rotation>,
    events: [] as { action: string; detail?: unknown }[],
    statusWhenPurged: undefined as string | undefined,
    transitions: [] as string[]
  };

  const clone = () => ({ ...world.row });
  const migrationRepository = {
    getById: jest.fn(async () => (world.row ? clone() : null)),
    update: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(world.row, patch);
      return clone();
    }),
    recordEvent: jest.fn(async (_id: string, entry: { action: string; detail?: unknown }) => {
      world.events.push({ action: entry.action, detail: entry.detail });
    })
  };
  const migrationService = {
    advance: jest.fn(async (_id: string, to: Status, _actor: string | null, patch: Record<string, unknown> = {}) => {
      if (!canTransition(world.row.status as Status, to)) {
        throw new Error(`illegal transition ${world.row.status} -> ${to}`);
      }
      Object.assign(world.row, patch, { status: to });
      world.transitions.push(to);
      return clone();
    })
  };
  const access = {
    shared: jest.fn(async () => SHARED),
    dedicatedOfOrg: jest.fn(async () => DEDICATED)
  };
  const agentClient = {
    getRelay: jest.fn(async () => {
      if (!world.relay) {
        throw new MigrationAgentError('NOT_FOUND', 404);
      }
      return world.relay;
    }),
    getAgentInfo: jest.fn(async () => ({ endpoints: ['https://didcomm.org.example.com'], isInitialized: true })),
    purgeProfile: jest.fn(async () => {
      world.statusWhenPurged = world.row.status;
      return { profileRemoved: true };
    }),
    startRotation: jest.fn(async () => world.rotationStatus),
    getRotationStatus: jest.fn(async () => world.rotationStatus)
  } as Record<string, jest.Mock>;
  const webhookService = { check: jest.fn(async () => ({ confirmed: true }) as { confirmed: boolean; code?: string }) };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const service = new OrgAgentMigrationSwitchOverService(
    migrationRepository as never,
    migrationService as never,
    access as never,
    agentClient as never,
    webhookService as never,
    logger as never
  );
  return { world, service, migrationRepository, migrationService, access, agentClient, webhookService, logger };
};

const actions = (world: ReturnType<typeof buildWorld>['world']) => world.events.map((event) => event.action);

describe('rotationSettled', () => {
  it.each([
    ['everything updated', rotation('completed'), true],
    ['an empty org', rotation('completed', { total: 0, updated: 0 }), true],
    ['some refused and some stale', rotation('completed', { refused: 2, stale: 3, updated: 5 }), true],
    ['connections that failed for good', rotation('completed', { failed: 2, updated: 8 }), true],
    ['holders still to answer', rotation('completed', { waiting: 3, updated: 7 }), false],
    ['connections not yet sent', rotation('completed', { pending: 1, updated: 9 }), false],
    ['connections being retried', rotation('completed', { retrying: 1, updated: 9 }), false],
    ['the job still running', rotation('running'), false],
    ['no job yet', rotation('idle'), false]
  ])('is judged for %s', (_name, status, expected) => {
    expect(rotationSettled(status as never)).toBe(expected);
  });
});

describe('ending the stabilisation window', () => {
  it('moves a migration whose window has ended and whose checks pass to ROTATING', async () => {
    const { service, world } = buildWorld();

    await expect(service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('STARTED');

    expect(world.row.status).toBe(Status.ROTATING);
    expect(actions(world)).toEqual(['SWITCHOVER_STARTED']);
  });

  it('does not purge or rotate by itself: that is the next step, after the point of no return is recorded', async () => {
    const { service, agentClient } = buildWorld();

    await service.beginSwitchOver(MIGRATION_ID);

    expect(agentClient.purgeProfile).not.toHaveBeenCalled();
    expect(agentClient.startRotation).not.toHaveBeenCalled();
  });

  it('fires at once for a window of zero hours', async () => {
    const { service } = buildWorld({ stabilisationEndsAt: new Date() });

    await expect(service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('STARTED');
  });

  it('leaves a migration alone while its window is still open', async () => {
    const { service, world, agentClient, migrationService } = buildWorld({
      stabilisationEndsAt: new Date(Date.now() + 10 * MINUTE)
    });

    await expect(service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('SKIPPED');

    expect(world.row.status).toBe(Status.STABILISING);
    expect(agentClient.getRelay).not.toHaveBeenCalled();
    expect(migrationService.advance).not.toHaveBeenCalled();
  });

  it.each([
    Status.CREATED,
    Status.REHEARSED,
    Status.FROZEN,
    Status.CUTOVER,
    Status.ROTATING,
    Status.COMPLETED,
    Status.FAILED
  ])('ignores a migration in %s', async (status) => {
    const { service, migrationService } = buildWorld({ status });

    await expect(service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('SKIPPED');

    expect(migrationService.advance).not.toHaveBeenCalled();
  });

  it('ignores a migration with no window set', async () => {
    const { service } = buildWorld({ stabilisationEndsAt: null });

    await expect(service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('SKIPPED');
  });

  it('ignores a migration that does not exist', async () => {
    const { service, migrationRepository } = buildWorld();
    migrationRepository.getById.mockResolvedValue(null);

    await expect(service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('SKIPPED');
  });

  it('gives way when something else moved the migration first', async () => {
    const { service, migrationService } = buildWorld();
    migrationService.advance.mockRejectedValue(new Error('changed'));

    await expect(service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('SKIPPED');
  });
});

describe('what keeps the shared copy from being deleted', () => {
  const blockers: [string, string, (w: ReturnType<typeof buildWorld>) => void][] = [
    ['the relay is only holding', 'RELAY_NOT_FORWARDING', (w) => (w.world.relay = { mode: 'HOLD' })],
    ['the relay forwards to nowhere', 'RELAY_NOT_FORWARDING', (w) => (w.world.relay = { mode: 'FORWARD' })],
    ['there is no relay', 'RELAY_NOT_FORWARDING', (w) => (w.world.relay = undefined)],
    [
      'the relay cannot be read',
      'SHARED_AGENT_UNAVAILABLE',
      (w) => w.agentClient.getRelay.mockRejectedValue(new MigrationAgentError('UNREACHABLE'))
    ],
    [
      'the shared agent cannot be reached',
      'SHARED_AGENT_UNAVAILABLE',
      (w) => w.access.shared.mockResolvedValue(undefined)
    ],
    ['the org has no tenant on record', 'SHARED_AGENT_UNAVAILABLE', (w) => (w.world.row.tenantId = null)],
    [
      'the org has no dedicated agent row',
      'DEDICATED_AGENT_UNAVAILABLE',
      (w) => w.access.dedicatedOfOrg.mockResolvedValue(undefined)
    ],
    [
      'the org row cannot be read',
      'DEDICATED_AGENT_UNAVAILABLE',
      (w) => w.access.dedicatedOfOrg.mockRejectedValue(new Error('bad ciphertext'))
    ],
    [
      'the dedicated agent cannot be reached',
      'DEDICATED_AGENT_UNREACHABLE',
      (w) => w.agentClient.getAgentInfo.mockRejectedValue(new MigrationAgentError('UNREACHABLE'))
    ],
    [
      'the dedicated agent is not initialised',
      'DEDICATED_AGENT_NOT_READY',
      (w) => w.agentClient.getAgentInfo.mockResolvedValue({ isInitialized: false, endpoints: [] })
    ],
    [
      "the new agent's webhooks cannot reach the platform",
      'WEBHOOK_UNREACHABLE',
      (w) => w.webhookService.check.mockResolvedValue({ confirmed: false, code: 'WEBHOOK_UNREACHABLE' })
    ],
    [
      'another webhook check is still running',
      'WEBHOOK_CHECK_BUSY',
      (w) => w.webhookService.check.mockResolvedValue({ confirmed: false, code: 'WEBHOOK_CHECK_BUSY' })
    ]
  ];

  it.each(blockers)('when %s it waits (%s) and never purges', async (_name, code, arrange) => {
    const world = buildWorld();
    arrange(world);

    await expect(world.service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('DEFERRED');

    expect(world.world.row.status).toBe(Status.STABILISING);
    expect(world.world.row.error).toBe(`SWITCHOVER_DEFERRED:${code}`);
    expect(world.agentClient.purgeProfile).not.toHaveBeenCalled();
    expect(world.agentClient.startRotation).not.toHaveBeenCalled();
  });

  it('says why once, however many ticks it waits', async () => {
    const world = buildWorld();
    world.world.relay = { mode: 'HOLD' };

    await world.service.beginSwitchOver(MIGRATION_ID);
    await world.service.beginSwitchOver(MIGRATION_ID);
    await world.service.beginSwitchOver(MIGRATION_ID);

    expect(actions(world.world)).toEqual(['SWITCHOVER_WAITING']);
    expect(world.migrationRepository.update).toHaveBeenCalledTimes(1);
  });

  it('says so again when the reason changes', async () => {
    const world = buildWorld();
    world.world.relay = { mode: 'HOLD' };
    await world.service.beginSwitchOver(MIGRATION_ID);

    world.world.relay = { mode: 'FORWARD', target: 'https://didcomm.org.example.com' };
    world.agentClient.getAgentInfo.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));
    await world.service.beginSwitchOver(MIGRATION_ID);

    expect(world.world.row.error).toBe('SWITCHOVER_DEFERRED:DEDICATED_AGENT_UNREACHABLE');
    expect(actions(world.world)).toEqual(['SWITCHOVER_WAITING', 'SWITCHOVER_WAITING']);
  });

  it('goes ahead, and clears the reason, once the problem is gone', async () => {
    const world = buildWorld();
    world.world.relay = { mode: 'HOLD' };
    await world.service.beginSwitchOver(MIGRATION_ID);

    world.world.relay = { mode: 'FORWARD', target: 'https://didcomm.org.example.com' };
    await expect(world.service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('STARTED');

    expect(world.world.row).toMatchObject({ status: Status.ROTATING, error: null });
  });

  it('still waits when the audit write fails', async () => {
    const world = buildWorld();
    world.world.relay = { mode: 'HOLD' };
    world.migrationRepository.recordEvent.mockRejectedValue(new Error('db down'));

    await expect(world.service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('DEFERRED');
  });
});

describe('the webhook gate', () => {
  it('checks the new agent with a fresh probe before it lets the purge go ahead', async () => {
    const world = buildWorld();

    await expect(world.service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('STARTED');

    expect(world.webhookService.check).toHaveBeenCalledWith(expect.objectContaining({ id: MIGRATION_ID }), DEDICATED);
  });

  it.each([
    ['a preflight from before the webhook check existed', { checks: [{ id: 'RELEASE_MATCHES', status: 'PASS' }] }],
    ['no preflight report at all', null]
  ])('does not hold %s to the probe, since its own agent may not answer it', async (_name, preflight) => {
    const world = buildWorld({ preflight });

    await expect(world.service.beginSwitchOver(MIGRATION_ID)).resolves.toBe('STARTED');

    expect(world.webhookService.check).not.toHaveBeenCalled();
  });

  it('does not probe while the window is still open', async () => {
    const world = buildWorld({ stabilisationEndsAt: new Date(Date.now() + MINUTE) });

    await world.service.beginSwitchOver(MIGRATION_ID);

    expect(world.webhookService.check).not.toHaveBeenCalled();
  });
});

describe('checking webhooks while the window is open', () => {
  const open = () => buildWorld({ stabilisationEndsAt: new Date(Date.now() + 60 * MINUTE) });

  it('records that it arrived and audits it, leaving a clean row clean', async () => {
    const world = open();

    await world.service.checkWebhook(MIGRATION_ID);

    expect(world.world.row.error).toBeNull();
    expect(actions(world.world)).toEqual(['WEBHOOK_CONFIRMED']);
    expect(world.webhookService.check).toHaveBeenCalledWith(expect.objectContaining({ id: MIGRATION_ID }), DEDICATED);
  });

  it('clears an earlier webhook problem once it arrives, but not an unrelated one', async () => {
    const earlier = open();
    earlier.world.row.error = 'WEBHOOK_UNREACHABLE';
    await earlier.service.checkWebhook(MIGRATION_ID);
    expect(earlier.world.row.error).toBeNull();

    const unrelated = open();
    unrelated.world.row.error = 'SHARED_AGENT_UNAVAILABLE';
    await unrelated.service.checkWebhook(MIGRATION_ID);
    expect(unrelated.world.row.error).toBe('SHARED_AGENT_UNAVAILABLE');
  });

  it('puts the reason on the migration, once, when it does not arrive', async () => {
    const world = open();
    world.webhookService.check.mockResolvedValue({ confirmed: false, code: 'WEBHOOK_NOT_CONFIGURED' });

    await world.service.checkWebhook(MIGRATION_ID);
    await world.service.checkWebhook(MIGRATION_ID);

    expect(world.world.row.error).toBe('WEBHOOK_NOT_CONFIGURED');
    expect(actions(world.world)).toEqual(['WEBHOOK_UNCONFIRMED']);
  });

  it('says nothing about a check that could not run, since that is not a webhook problem', async () => {
    const world = open();
    world.webhookService.check.mockResolvedValue({ confirmed: false, code: 'AGENT_UNAVAILABLE' });

    await world.service.checkWebhook(MIGRATION_ID);

    expect(world.world.row.error).toBeNull();
    expect(actions(world.world)).toEqual([]);
  });

  it.each([
    ['it has already been confirmed', { webhookConfirmedAt: new Date() }],
    ['the migration is not stabilising', { status: Status.ROTATING }]
  ])('does nothing when %s', async (_name, overrides) => {
    const world = buildWorld({ stabilisationEndsAt: new Date(Date.now() + 60 * MINUTE), ...overrides });

    await world.service.checkWebhook(MIGRATION_ID);

    expect(world.webhookService.check).not.toHaveBeenCalled();
  });

  it('does nothing without a dedicated agent to ask', async () => {
    const world = open();
    world.access.dedicatedOfOrg.mockResolvedValue(undefined);

    await world.service.checkWebhook(MIGRATION_ID);

    expect(world.webhookService.check).not.toHaveBeenCalled();
  });
});

describe('after the window: purge, rotate, complete', () => {
  const rotating = (overrides: Record<string, unknown> = {}) => buildWorld({ status: Status.ROTATING, ...overrides });

  it('purges, starts the rotation and records progress on the first pass', async () => {
    const { service, world, agentClient } = rotating();

    await service.advanceRotation(MIGRATION_ID);

    expect(agentClient.purgeProfile).toHaveBeenCalledWith(SHARED.endpoint, SHARED.token, 'tenant-1');
    expect(agentClient.startRotation).toHaveBeenCalledWith(DEDICATED.endpoint, DEDICATED.token);
    expect(world.row.purgedAt).toBeInstanceOf(Date);
    expect(world.row.rotationJobId).toBe('rotate-all:2026-10-23T08:00:00.000Z');
    expect(world.row.rotation).toMatchObject({ job: { status: 'running' }, counts: { pending: 10 } });
    expect(world.row.status).toBe(Status.ROTATING);
  });

  it('purges before it rotates', async () => {
    const { service, agentClient } = rotating();

    await service.advanceRotation(MIGRATION_ID);

    expect(agentClient.purgeProfile.mock.invocationCallOrder[0]).toBeLessThan(
      agentClient.startRotation.mock.invocationCallOrder[0]
    );
  });

  it('purges only once the migration is already ROTATING, so a disaster restore can no longer race it', async () => {
    const world = buildWorld();

    await world.service.beginSwitchOver(MIGRATION_ID);
    await world.service.advanceRotation(MIGRATION_ID);

    expect(world.world.statusWhenPurged).toBe(Status.ROTATING);
  });

  it('records what it did for the audit trail', async () => {
    const { service, world } = rotating();

    await service.advanceRotation(MIGRATION_ID);

    expect(world.events).toEqual([
      { action: 'PROFILE_PURGED', detail: { profileRemoved: true } },
      { action: 'ROTATION_STARTED', detail: { connections: 10 } }
    ]);
  });

  it('keeps watching, and updates the progress, while holders have yet to answer', async () => {
    const { service, world, migrationService } = rotating({ purgedAt: new Date(), rotationJobId: 'rotate-all:x' });
    world.rotationStatus = rotation('completed', { waiting: 4, updated: 6 });

    await service.advanceRotation(MIGRATION_ID);

    expect(world.row.status).toBe(Status.ROTATING);
    expect(world.row.rotation).toMatchObject({ counts: { waiting: 4, updated: 6 } });
    expect(migrationService.advance).not.toHaveBeenCalled();
  });

  it('completes the migration once everyone has answered, been refused or gone stale', async () => {
    const { service, world } = rotating({ purgedAt: new Date(), rotationJobId: 'rotate-all:x' });
    world.rotationStatus = rotation('completed', { updated: 7, refused: 1, stale: 2 });

    await service.advanceRotation(MIGRATION_ID);

    expect(world.row.status).toBe(Status.COMPLETED);
    expect(world.row.rotation).toMatchObject({
      job: { status: 'completed' },
      counts: { updated: 7, refused: 1, stale: 2 }
    });
    expect(actions(world)).toEqual(['MOVE_COMPLETED']);
  });

  it('completes an organisation that has no connections at all', async () => {
    const { service, world } = rotating();
    world.rotationStatus = rotation('completed', { total: 0, updated: 0 });

    await service.advanceRotation(MIGRATION_ID);

    expect(world.row.status).toBe(Status.COMPLETED);
  });

  it('walks the whole way from the end of the window to COMPLETED, through legal states only', async () => {
    const world = buildWorld();

    await world.service.beginSwitchOver(MIGRATION_ID);
    await world.service.advanceRotation(MIGRATION_ID);
    expect(world.world.row.status).toBe(Status.ROTATING);
    world.world.rotationStatus = rotation('completed', { waiting: 2, updated: 8 });
    await world.service.advanceRotation(MIGRATION_ID);
    expect(world.world.row.status).toBe(Status.ROTATING);
    world.world.rotationStatus = rotation('completed');
    await world.service.advanceRotation(MIGRATION_ID);

    expect(world.world.transitions).toEqual([Status.ROTATING, Status.COMPLETED]);
    expect(actions(world.world)).toEqual([
      'SWITCHOVER_STARTED',
      'PROFILE_PURGED',
      'ROTATION_STARTED',
      'MOVE_COMPLETED'
    ]);
  });

  describe('repeating', () => {
    it('does not purge again once it has', async () => {
      const { service, agentClient } = rotating({ purgedAt: new Date() });

      await service.advanceRotation(MIGRATION_ID);

      expect(agentClient.purgeProfile).not.toHaveBeenCalled();
      expect(agentClient.startRotation).toHaveBeenCalled();
    });

    it('does not start the rotation again once it has', async () => {
      const { service, agentClient } = rotating({ purgedAt: new Date(), rotationJobId: 'rotate-all:x' });

      await service.advanceRotation(MIGRATION_ID);

      expect(agentClient.startRotation).not.toHaveBeenCalled();
      expect(agentClient.getRotationStatus).toHaveBeenCalled();
    });

    it('starts the rotation again when the agent has lost its job', async () => {
      const { service, world, agentClient } = rotating({ purgedAt: new Date(), rotationJobId: 'rotate-all:x' });
      agentClient.getRotationStatus.mockResolvedValue(rotation('idle'));
      agentClient.startRotation.mockResolvedValue(rotation('running', { pending: 10, updated: 0 }));

      await service.advanceRotation(MIGRATION_ID);

      expect(agentClient.startRotation).toHaveBeenCalledTimes(1);
      expect(world.row.rotation).toMatchObject({ job: { status: 'running' } });
    });

    it('does not restart a finished job because a holder connected after it: that holder is already on the new agent', async () => {
      const { service, world, agentClient } = rotating({ purgedAt: new Date(), rotationJobId: 'rotate-all:x' });
      agentClient.getRotationStatus.mockResolvedValue(rotation('completed', { pending: 2, waiting: 4, updated: 6 }));

      await service.advanceRotation(MIGRATION_ID);

      expect(agentClient.startRotation).not.toHaveBeenCalled();
      expect(world.row.status).toBe(Status.ROTATING);
    });

    it('leaves a finished job alone while only holders that have been sent the change are left', async () => {
      const { service, agentClient } = rotating({ purgedAt: new Date(), rotationJobId: 'rotate-all:x' });
      agentClient.getRotationStatus.mockResolvedValue(rotation('completed', { waiting: 4, failed: 1, updated: 5 }));

      await service.advanceRotation(MIGRATION_ID);

      expect(agentClient.startRotation).not.toHaveBeenCalled();
    });

    it('does nothing for a migration that is not rotating', async () => {
      const { service, agentClient } = buildWorld({ status: Status.STABILISING });

      await service.advanceRotation(MIGRATION_ID);

      expect(agentClient.purgeProfile).not.toHaveBeenCalled();
    });

    it('does nothing for a migration that does not exist', async () => {
      const { service, migrationRepository, agentClient } = rotating();
      migrationRepository.getById.mockResolvedValue(null);

      await service.advanceRotation(MIGRATION_ID);

      expect(agentClient.purgeProfile).not.toHaveBeenCalled();
    });
  });

  describe('when something goes wrong', () => {
    it('says the purge was refused when the agent refuses it, and does not rotate', async () => {
      const { service, world, agentClient } = rotating();
      agentClient.purgeProfile.mockRejectedValue(new MigrationAgentError('CONFLICT', 409, 'RELAY_NOT_FORWARDING'));

      await service.advanceRotation(MIGRATION_ID);

      expect(world.row.error).toBe('PURGE_REFUSED');
      expect(world.row.purgedAt).toBeNull();
      expect(agentClient.startRotation).not.toHaveBeenCalled();
    });

    it('says the purge failed when the shared agent is down, and tries again next time', async () => {
      const { service, world, agentClient } = rotating();
      agentClient.purgeProfile.mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'));
      await service.advanceRotation(MIGRATION_ID);
      expect(world.row.error).toBe('PURGE_FAILED');

      await service.advanceRotation(MIGRATION_ID);

      expect(world.row).toMatchObject({ error: null });
      expect(world.row.purgedAt).toBeInstanceOf(Date);
      expect(world.row.rotationJobId).toBeTruthy();
    });

    it('keeps the purge when the rotation cannot start, and starts it next time', async () => {
      const { service, world, agentClient } = rotating();
      agentClient.startRotation.mockRejectedValueOnce(new MigrationAgentError('FAILED', 500));
      await service.advanceRotation(MIGRATION_ID);
      expect(world.row.error).toBe('ROTATION_START_FAILED');
      expect(world.row.purgedAt).toBeInstanceOf(Date);

      await service.advanceRotation(MIGRATION_ID);

      expect(agentClient.purgeProfile).toHaveBeenCalledTimes(1);
      expect(world.row.rotationJobId).toBeTruthy();
    });

    it('leaves the state alone when the rotation status cannot be read', async () => {
      const { service, world, agentClient, migrationService } = rotating({
        purgedAt: new Date(),
        rotationJobId: 'rotate-all:x'
      });
      agentClient.getRotationStatus.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

      await service.advanceRotation(MIGRATION_ID);

      expect(world.row).toMatchObject({ status: Status.ROTATING, error: 'ROTATION_STATUS_UNAVAILABLE' });
      expect(migrationService.advance).not.toHaveBeenCalled();
    });

    it.each([
      [
        'the shared agent',
        (w: ReturnType<typeof buildWorld>) => w.access.shared.mockResolvedValue(undefined),
        'SHARED_AGENT_UNAVAILABLE'
      ],
      [
        'the dedicated agent',
        (w: ReturnType<typeof buildWorld>) => w.access.dedicatedOfOrg.mockResolvedValue(undefined),
        'DEDICATED_AGENT_UNAVAILABLE'
      ]
    ])('waits when it cannot find %s, and purges nothing', async (_name, arrange, code) => {
      const world = rotating();
      arrange(world);

      await world.service.advanceRotation(MIGRATION_ID);

      expect(world.world.row.error).toBe(code);
      expect(world.agentClient.purgeProfile).not.toHaveBeenCalled();
    });

    it('does not repeat the same complaint on every pass', async () => {
      const { service, world, agentClient } = rotating();
      agentClient.purgeProfile.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

      await service.advanceRotation(MIGRATION_ID);
      await service.advanceRotation(MIGRATION_ID);
      await service.advanceRotation(MIGRATION_ID);

      expect(actions(world)).toEqual(['SWITCHOVER_WAITING']);
    });

    it('does not complete when the migration changed under it', async () => {
      const { service, world, migrationService } = rotating({ purgedAt: new Date(), rotationJobId: 'rotate-all:x' });
      world.rotationStatus = rotation('completed');
      migrationService.advance.mockRejectedValue(new Error('changed'));

      await expect(service.advanceRotation(MIGRATION_ID)).resolves.toBeUndefined();

      expect(actions(world)).not.toContain('MOVE_COMPLETED');
    });
  });

  it('never logs a token', async () => {
    const { service, logger, agentClient } = rotating();
    agentClient.purgeProfile.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

    await service.advanceRotation(MIGRATION_ID);

    expect(JSON.stringify([...logger.error.mock.calls, ...logger.warn.mock.calls])).not.toMatch(
      /root-token|base-token/
    );
  });
});
