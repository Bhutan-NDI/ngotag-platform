/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-explicit-any, prefer-destructuring, no-mixed-operators */
/**
 * Move day against an in-memory world: the migration row, the org's agent row, the relay, the S3 export and both
 * agents. The state machine is the real one, so an illegal transition fails the test.
 */
import { ConflictException } from '@nestjs/common';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { MigrationAgentError } from './migration-agent.client';
import { countsMatchRehearsal, OrgAgentMigrationExecutor } from './org-agent-migration.executor.service';
import { canTransition, isFrozen } from './org-agent-migration.state-machine';

const MIGRATION_ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';
const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';
const MINUTE = 60 * 1000;
const ORG_DID = 'did:polygon:0xabc';
const PUBLIC_KEY = Buffer.from('import-public-key').toString('base64');

const SHARED = { endpoint: 'https://shared.example.com', token: 'base-token' };
const DEDICATED = { endpoint: 'https://admin.org.example.com', token: 'root-token' };

const exportedJob = {
  jobId: 'export-1',
  status: 'completed',
  downloadUrl: 'https://bucket.s3.amazonaws.com/e.db.gz?sig=SECRET-SIGNATURE',
  checksum: 'a'.repeat(64),
  sealedStoreKey: 'c2VhbGVk',
  storageVersion: '0.5'
};
const importedJob = { jobId: 'import-1', status: 'completed', counts: { entries: 130, keys: 5, skipped: 0 } };

const infoOf = (endpoint: string) => ({
  endpoints: [endpoint],
  isInitialized: true,
  releaseVersion: '2.1.3',
  storageVersion: '0.5',
  config: {
    autoAcceptConnections: true,
    autoAcceptCredentials: 'always',
    autoAcceptProofs: 'contentApproved',
    inboundTransports: ['http'],
    outboundTransports: ['http', 'ws'],
    cronPurgeEnabled: true
  }
});

const buildWorld = (rowOverrides: Record<string, unknown> = {}) => {
  const world = {
    row: {
      id: MIGRATION_ID,
      orgId: ORG_ID,
      status: Status.SCHEDULED as string,
      startedBy: USER_ID,
      tenantId: 'tenant-1',
      targetAdminEndpoint: DEDICATED.endpoint,
      targetDidcommEndpoint: 'https://didcomm.org.example.com',
      targetTokenEncrypted: 'ENCRYPTED-TOKEN',
      predictedFreezeMs: 15 * MINUTE,
      counts: { entries: 120, keys: 5, skipped: 0 },
      sourceOrgAgentSnapshot: { agentEndPoint: SHARED.endpoint, walletName: 'org-wallet', orgDid: ORG_DID },
      exportJobId: null,
      freezeDeadline: null as Date | null,
      newInvitationDid: null,
      legacyInvitationDid: null,
      error: null as string | null,
      ...rowOverrides
    } as Record<string, any>,
    orgAgent: {
      id: 'agent-row-1',
      orgAgentTypeId: 'shared-type',
      agentEndPoint: SHARED.endpoint,
      tenantId: 'tenant-1',
      walletName: 'org-wallet',
      apiKey: 'shared-token'
    },
    relay: 'none' as 'none' | 'HOLD' | 'FORWARD',
    relayTarget: undefined as string | undefined,
    heldMessages: 3,
    exports: new Set<string>(),
    events: [] as { action?: string; to?: string; detail?: unknown }[],
    transitions: [] as string[],
    statusAt: {} as Record<string, string>,
    invitations: [] as unknown[],
    confirmingActor: null as string | null
  };

  const clone = () => (world.row ? { ...world.row, freezeDeadline: world.row.freezeDeadline } : null);
  const migrationRepository: Record<string, jest.Mock> = {
    getConfirmingActor: jest.fn(async () => world.confirmingActor),
    getById: jest.fn(async () => clone()),
    update: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(world.row, patch);
      return clone();
    }),
    attachNewInvitation: jest.fn(async (params: any) => {
      world.invitations.push(params);
      Object.assign(world.row, {
        newInvitationDid: params.newInvitationDid,
        legacyInvitationDid: params.legacyInvitationDid
      });
      return clone();
    }),
    recordEvent: jest.fn(async (_id: string, entry: { action: string; detail?: unknown }) => {
      world.events.push({ action: entry.action, detail: entry.detail });
    }),
    cutover: jest.fn(async (params: any) => {
      if (world.row.status !== Status.VERIFYING) {
        throw new ConflictException('changed');
      }
      if (
        world.orgAgent.orgAgentTypeId !== params.sharedOrgAgentTypeId ||
        world.orgAgent.agentEndPoint !== params.expectedAgentEndPoint
      ) {
        throw new ConflictException('agent row changed');
      }
      Object.assign(world.orgAgent, {
        orgAgentTypeId: params.dedicatedOrgAgentTypeId,
        agentEndPoint: params.agentEndPoint,
        apiKey: params.encryptedToken,
        tenantId: null
      });
      Object.assign(world.row, params.patch, { status: Status.CUTOVER });
      world.transitions.push(Status.CUTOVER);
      return clone();
    })
  };
  const migrationService: Record<string, jest.Mock> = {
    advance: jest.fn(async (_id: string, to: Status, _actor: string | null, patch: Record<string, unknown> = {}) => {
      if (!canTransition(world.row.status as Status, to)) {
        throw new Error(`illegal transition ${world.row.status} -> ${to}`);
      }
      Object.assign(world.row, patch, { status: to });
      world.transitions.push(to);
      return clone();
    }),
    abort: jest.fn(async (_id: string, code: string) => {
      if (!canTransition(world.row.status as Status, Status.FAILED)) {
        throw new Error(`cannot abort from ${world.row.status}`);
      }
      Object.assign(world.row, { status: Status.FAILED, error: code });
      world.transitions.push(Status.FAILED);
      return clone();
    })
  };
  const agentServiceRepository: Record<string, jest.Mock> = {
    getAgentDetailsByOrgId: jest.fn(async () => ({ ...world.orgAgent })),
    getOrgAgentTypeDetails: jest.fn(async (type: string) => ('SHARED' === type ? 'shared-type' : 'dedicated-type'))
  };
  const access: Record<string, jest.Mock> = {
    shared: jest.fn(async () => SHARED),
    dedicated: jest.fn(async () => DEDICATED)
  };
  const calls: string[] = [];
  const log = (name: string) => {
    calls.push(name);
    world.statusAt[name] = world.row.status;
  };
  const agentClient: Record<string, jest.Mock> = {
    putRelay: jest.fn(async (_e: string, _t: string, _tenant: string, body: any) => {
      log(`putRelay:${body.mode}`);
      world.relay = body.mode;
      world.relayTarget = body.target;
      return { mode: body.mode };
    }),
    reinjectRelay: jest.fn(async () => {
      log('reinjectRelay');
      const injected = world.heldMessages;
      world.heldMessages = 0;
      return { injected, failed: 0 };
    }),
    deleteRelay: jest.fn(async () => {
      log('deleteRelay');
      if ('none' === world.relay) {
        throw new MigrationAgentError('NOT_FOUND', 404);
      }
      world.relay = 'none';
    }),
    createImportSession: jest.fn(async () => {
      log('createImportSession');
      return { sessionId: 'session-1', importPublicKey: PUBLIC_KEY };
    }),
    startSealedExport: jest.fn(async () => {
      log('startSealedExport');
      world.exports.add('export-1');
      return { jobId: 'export-1', status: 'pending' };
    }),
    getExportJob: jest.fn(async () => exportedJob),
    startImport: jest.fn(async () => {
      log('startImport');
      return { jobId: 'import-1', status: 'pending' };
    }),
    pushImport: jest.fn(async () => {
      log('pushImport');
      return { jobId: 'import-1', status: 'pending' };
    }),
    getImportJob: jest.fn(async () => importedJob),
    deleteExport: jest.fn(async () => {
      log('deleteExport');
      world.exports.delete('export-1');
    }),
    getAgentInfo: jest.fn(async (endpoint: string) =>
      endpoint === DEDICATED.endpoint ? infoOf('https://didcomm.org.example.com') : infoOf('https://shared.example.com')
    ),
    createSelfAttestedCredential: jest.fn(async () => ({ credential: { issuer: ORG_DID, id: 'urn:uuid:1' } })),
    verifyCredential: jest.fn(async () => ({ isValid: true })),
    probeRelayTarget: jest.fn(async () => ({ reachable: true, status: 404 })),
    createConnectionInvitation: jest.fn(async () => {
      log('createConnectionInvitation');
      return { invitationUrl: 'https://didcomm.org.example.com?oob=abc', invitationDid: 'did:peer:2.new' };
    })
  };
  const alertService: Record<string, jest.Mock> = { alertKeyExport: jest.fn(async () => ({ recipients: 3, sent: 3 })) };
  const connectionRepository: Record<string, jest.Mock> = {
    getAgentEndPoint: jest.fn(async () => ({
      id: 'agent-row-1',
      organisation: { name: 'Acme Ltd', logoUrl: 'https://logo.example.com/a.png' }
    })),
    getInvitationDidByOrgId: jest.fn(async () => ({ invitationDid: 'did:peer:2.legacy' }))
  };
  const connectionService: Record<string, jest.Mock> = {
    storeConnectionObjectAndReturnUrl: jest.fn(async () => 'https://short.example.com/abc')
  };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };

  const executor = new OrgAgentMigrationExecutor(
    migrationRepository as never,
    migrationService as never,
    agentServiceRepository as never,
    access as never,
    agentClient as never,
    alertService as never,
    connectionRepository as never,
    connectionService as never,
    logger as never
  );
  return {
    world,
    executor,
    calls,
    migrationRepository,
    migrationService,
    agentServiceRepository,
    access,
    agentClient,
    alertService,
    connectionRepository,
    connectionService,
    logger
  };
};

beforeEach(() => {
  process.env.ORG_MIGRATION_DRAIN_MS = '1';
  process.env.ORG_MIGRATION_POLL_INTERVAL_MS = '1';
  process.env.ORG_MIGRATION_RETRY_MS = '1';
  process.env.ORG_MIGRATION_EXPORT_CLEANUP_WAIT_MS = '20';
});

afterEach(() => {
  for (const name of [
    'ORG_MIGRATION_DRAIN_MS',
    'ORG_MIGRATION_POLL_INTERVAL_MS',
    'ORG_MIGRATION_RETRY_MS',
    'ORG_MIGRATION_EXPORT_CLEANUP_WAIT_MS',
    'ORG_MIGRATION_JOB_TIMEOUT_MS',
    'ORG_MIGRATION_STABILISATION_HOURS',
    'ORG_MIGRATION_COUNT_TOLERANCE'
  ]) {
    delete process.env[name];
  }
});

const noSecrets = (logger: { error: jest.Mock; warn: jest.Mock; log: jest.Mock }) =>
  JSON.stringify([...logger.error.mock.calls, ...logger.warn.mock.calls, ...logger.log.mock.calls]);

describe('countsMatchRehearsal', () => {
  const rehearsal = { entries: 100, keys: 10 };

  it.each([
    [{ entries: 100, keys: 10 }, true],
    [{ entries: 250, keys: 30 }, true],
    [{ entries: 80, keys: 10 }, true],
    [{ entries: 79, keys: 10 }, false],
    [{ entries: 100, keys: 9 }, false],
    [{ entries: 100, keys: 7 }, false],
    [{ entries: 0, keys: 0 }, false]
  ])('moved %j against a 20%% tolerance on entries is %s', (moved, expected) => {
    expect(countsMatchRehearsal(rehearsal, moved, 0.2)).toBe(expected);
  });

  it('refuses a result with no counts', () => {
    expect(countsMatchRehearsal(rehearsal, undefined, 0.2)).toBe(false);
    expect(countsMatchRehearsal(rehearsal, { entries: Number.NaN, keys: 1 }, 0.2)).toBe(false);
  });

  it('refuses a move when there is no rehearsal to compare with', () => {
    expect(countsMatchRehearsal(null, { entries: 1, keys: 0 }, 0.2)).toBe(false);
    expect(countsMatchRehearsal(undefined, { entries: 100, keys: 10 }, 0.2)).toBe(false);
  });
});

describe('move day: the whole move', () => {
  it('walks the migration through every state to STABILISING, never skipping one', async () => {
    const { executor, world } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.transitions).toEqual([
      Status.FROZEN,
      Status.EXPORTING,
      Status.IMPORTING,
      Status.VERIFYING,
      Status.CUTOVER,
      Status.STABILISING
    ]);
    expect(world.row.status).toBe(Status.STABILISING);
  });

  it('freezes with a deadline of the predicted pause', async () => {
    const { executor, migrationService } = buildWorld({ predictedFreezeMs: 40 * MINUTE });
    const before = Date.now();

    await executor.run(MIGRATION_ID, USER_ID);

    const [, , , patch] = migrationService.advance.mock.calls[0];
    expect(patch.freezeDeadline.getTime() - before).toBeGreaterThanOrEqual(40 * MINUTE);
    expect(patch.freezeDeadline.getTime() - before).toBeLessThan(40 * MINUTE + 5000);
  });

  it('holds the relay before the export, exports sealed to the new agent, then imports for real', async () => {
    const { executor, calls, agentClient } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(calls.slice(0, 5)).toEqual([
      'putRelay:HOLD',
      'createImportSession',
      'startSealedExport',
      'startImport',
      'putRelay:FORWARD'
    ]);
    expect(agentClient.startSealedExport).toHaveBeenCalledWith(SHARED.endpoint, SHARED.token, 'tenant-1', PUBLIC_KEY);
    expect(agentClient.startImport).toHaveBeenCalledWith(DEDICATED.endpoint, DEDICATED.token, {
      sessionId: 'session-1',
      exportUrl: exportedJob.downloadUrl,
      checksum: exportedJob.checksum,
      sealedStoreKey: exportedJob.sealedStoreKey,
      storageVersion: '0.5',
      dryRun: false
    });
  });

  it('alerts the owners and platform admins before the export, naming who confirmed the move', async () => {
    const { executor, alertService, calls } = buildWorld();
    let alertedBeforeExport = false;
    alertService.alertKeyExport.mockImplementation(async () => {
      alertedBeforeExport = !calls.includes('startSealedExport');
      return { recipients: 3, sent: 3 };
    });

    await executor.run(MIGRATION_ID, USER_ID);

    expect(alertService.alertKeyExport).toHaveBeenCalledWith(
      expect.objectContaining({ id: MIGRATION_ID }),
      'MOVE_EXPORT',
      USER_ID
    );
    expect(alertedBeforeExport).toBe(true);
  });

  it('records the export, the import key fingerprint, the checksum and the moved counts', async () => {
    const { executor, world } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.row).toMatchObject({
      exportJobId: 'export-1',
      importJobId: 'import-1',
      checksum: exportedJob.checksum,
      counts: importedJob.counts
    });
    expect(world.row.importKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('switches the org row to the dedicated agent only after every check passed', async () => {
    const { executor, world, migrationRepository, agentClient } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(migrationRepository.cutover).toHaveBeenCalledWith(
      expect.objectContaining({
        migrationId: MIGRATION_ID,
        orgId: ORG_ID,
        expectedAgentEndPoint: SHARED.endpoint,
        expectedTenantId: 'tenant-1',
        sharedOrgAgentTypeId: 'shared-type',
        dedicatedOrgAgentTypeId: 'dedicated-type',
        agentEndPoint: DEDICATED.endpoint,
        encryptedToken: 'ENCRYPTED-TOKEN',
        walletName: 'org-wallet'
      })
    );
    expect(world.orgAgent).toMatchObject({
      orgAgentTypeId: 'dedicated-type',
      agentEndPoint: DEDICATED.endpoint,
      tenantId: null
    });
    expect(agentClient.probeRelayTarget.mock.invocationCallOrder[0]).toBeLessThan(
      migrationRepository.cutover.mock.invocationCallOrder[0]
    );
  });

  it('keeps the org frozen until the very end, then unfreezes into the stabilisation window', async () => {
    const { executor, world } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    for (const step of [
      'putRelay:HOLD',
      'startSealedExport',
      'startImport',
      'putRelay:FORWARD',
      'createConnectionInvitation',
      'deleteExport'
    ]) {
      expect(isFrozen(world.statusAt[step] as Status)).toBe(true);
    }
    expect(isFrozen(world.row.status as Status)).toBe(false);
  });

  it('forwards held messages to the new DIDComm address and removes the export from S3', async () => {
    const { executor, world, agentClient } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.relay).toBe('FORWARD');
    expect(world.relayTarget).toBe('https://didcomm.org.example.com');
    expect(agentClient.deleteExport).toHaveBeenCalledWith(SHARED.endpoint, SHARED.token, 'tenant-1', 'export-1');
    expect(world.exports.size).toBe(0);
  });

  it('creates the new reusable invitation on the dedicated agent and records it beside the old one', async () => {
    const { executor, world, agentClient, migrationRepository, connectionService } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(agentClient.createConnectionInvitation).toHaveBeenCalledWith(DEDICATED.endpoint, DEDICATED.token, {
      multiUseInvitation: true,
      autoAcceptConnection: true,
      label: 'Acme Ltd',
      imageUrl: 'https://logo.example.com/a.png'
    });
    expect(connectionService.storeConnectionObjectAndReturnUrl).toHaveBeenCalledWith(
      'https://didcomm.org.example.com?oob=abc',
      true
    );
    expect(migrationRepository.attachNewInvitation).toHaveBeenCalledWith({
      migrationId: MIGRATION_ID,
      orgId: ORG_ID,
      agentId: 'agent-row-1',
      connectionInvitation: 'https://short.example.com/abc',
      newInvitationDid: 'did:peer:2.new',
      legacyInvitationDid: 'did:peer:2.legacy'
    });
    expect(world.row).toMatchObject({ newInvitationDid: 'did:peer:2.new', legacyInvitationDid: 'did:peer:2.legacy' });
  });

  it('reads the old invitation before saving the new one, so the new one is never taken for the old', async () => {
    const { executor, connectionRepository, migrationRepository } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(connectionRepository.getInvitationDidByOrgId.mock.invocationCallOrder[0]).toBeLessThan(
      migrationRepository.attachNewInvitation.mock.invocationCallOrder[0]
    );
  });

  it('records no legacy DID for an org that never had an invitation', async () => {
    const { executor, world, connectionRepository } = buildWorld();
    connectionRepository.getInvitationDidByOrgId.mockResolvedValue(null);

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.row.legacyInvitationDid).toBeNull();
  });

  it('opens the stabilisation window for 48 hours by default, and drops the migration’s own copy of the token', async () => {
    const { executor, world } = buildWorld();
    const before = Date.now();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.row.stabilisationEndsAt.getTime() - before).toBeGreaterThanOrEqual(48 * 60 * MINUTE);
    expect(world.row.stabilisationEndsAt.getTime() - before).toBeLessThan(48 * 60 * MINUTE + 5000);
    expect(world.row.targetTokenEncrypted).toBeNull();
  });

  it('forgets the webhook confirmation preflight left, so the window checks the webhook for itself', async () => {
    const { executor, world } = buildWorld({ webhookConfirmedAt: new Date('2026-10-01T00:00:00Z') });

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.row.status).toBe(Status.STABILISING);
    expect(world.row.webhookConfirmedAt).toBeNull();
  });

  it('allows a window of zero hours', async () => {
    process.env.ORG_MIGRATION_STABILISATION_HOURS = '0';
    const { executor, world } = buildWorld();
    const before = Date.now();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.row.stabilisationEndsAt.getTime() - before).toBeLessThan(5000);
  });

  it('reads the window from the environment', async () => {
    process.env.ORG_MIGRATION_STABILISATION_HOURS = '6';
    const { executor, world } = buildWorld();
    const before = Date.now();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.row.stabilisationEndsAt.getTime() - before).toBeGreaterThanOrEqual(6 * 60 * MINUTE);
    expect(world.row.stabilisationEndsAt.getTime() - before).toBeLessThan(6 * 60 * MINUTE + 5000);
  });

  it('audits the verification and never logs a token or the download URL', async () => {
    const { executor, world, logger } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.events.map((event) => event.action)).toEqual(['MOVE_EXPORT_STARTED', 'MOVE_VERIFIED']);
    expect(world.events[1].detail).toEqual({ entries: 130, keys: 5, rehearsalEntries: 120, rehearsalKeys: 5 });
    expect(noSecrets(logger)).not.toMatch(/root-token|base-token|SECRET-SIGNATURE|ENCRYPTED-TOKEN|c2VhbGVk/);
  });
});

describe('move day: starting', () => {
  it.each([Status.CREATED, Status.FROZEN, Status.EXPORTING, Status.CUTOVER, Status.STABILISING, Status.FAILED])(
    'does nothing for a migration in %s',
    async (status) => {
      const { executor, migrationService } = buildWorld({ status });

      await executor.run(MIGRATION_ID, USER_ID);

      expect(migrationService.advance).not.toHaveBeenCalled();
    }
  );

  it('does nothing for a migration that does not exist', async () => {
    const { executor, migrationRepository, migrationService } = buildWorld();
    migrationRepository.getById.mockResolvedValue(null);

    await executor.run(MIGRATION_ID, USER_ID);

    expect(migrationService.advance).not.toHaveBeenCalled();
  });

  it('claims the move only while it is still due: confirmed, rehearsed and past its slot', async () => {
    const world = buildWorld();

    await world.executor.run(MIGRATION_ID, USER_ID);

    const [, to, , patch, options] = world.migrationService.advance.mock.calls[0];
    expect(to).toBe(Status.FROZEN);
    expect(patch.importKeyFingerprint).toBeNull();
    expect(options.where).toEqual({ rehearsalStatus: 'DONE', scheduledFor: { lte: expect.any(Date) } });
  });

  it('lets only one of two simultaneous runs start the move', async () => {
    const { executor, agentClient } = buildWorld();

    await Promise.all([executor.run(MIGRATION_ID, USER_ID), executor.run(MIGRATION_ID, USER_ID)]);

    expect(agentClient.startSealedExport).toHaveBeenCalledTimes(1);
    expect(agentClient.startImport).toHaveBeenCalledTimes(1);
  });
});

describe('move day: aborting before the switch', () => {
  const orgUntouched = (world: ReturnType<typeof buildWorld>['world']) =>
    expect(world.orgAgent).toMatchObject({
      orgAgentTypeId: 'shared-type',
      agentEndPoint: SHARED.endpoint,
      tenantId: 'tenant-1',
      apiKey: 'shared-token'
    });

  const failures: [string, string, (w: ReturnType<typeof buildWorld>) => void][] = [
    [
      'the relay cannot be held',
      'RELAY_FAILED',
      (w) => w.agentClient.putRelay.mockRejectedValue(new MigrationAgentError('FAILED', 500))
    ],
    [
      'nobody could be alerted',
      'ALERT_FAILED',
      (w) => w.alertService.alertKeyExport.mockResolvedValue({ recipients: 2, sent: 0 })
    ],
    [
      'the target is not pristine',
      'TARGET_NOT_PRISTINE',
      (w) =>
        w.agentClient.createImportSession.mockRejectedValue(
          new MigrationAgentError('CONFLICT', 409, 'TARGET_NOT_PRISTINE')
        )
    ],
    [
      'the dedicated agent cannot be reached',
      'AGENT_UNREACHABLE',
      (w) => w.agentClient.createImportSession.mockRejectedValue(new MigrationAgentError('UNREACHABLE'))
    ],
    [
      'the export cannot start',
      'EXPORT_FAILED',
      (w) => w.agentClient.startSealedExport.mockRejectedValue(new MigrationAgentError('FAILED', 500))
    ],
    [
      'the export job fails',
      'EXPORT_FAILED',
      (w) => w.agentClient.getExportJob.mockResolvedValue({ ...exportedJob, status: 'failed' })
    ],
    [
      'the import is refused over the storage version',
      'STORAGE_VERSION_MISMATCH',
      (w) =>
        w.agentClient.startImport.mockRejectedValue(
          new MigrationAgentError('CONFLICT', 409, 'STORAGE_VERSION_MISMATCH')
        )
    ],
    [
      'the import job fails',
      'IMPORT_FAILED',
      (w) => w.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' })
    ],
    [
      'the import brings far fewer records than the rehearsal',
      'VERIFICATION_FAILED:COUNTS',
      (w) =>
        w.agentClient.getImportJob.mockResolvedValue({ ...importedJob, counts: { entries: 10, keys: 5, skipped: 0 } })
    ],
    [
      'the new agent reports another DIDComm address',
      'VERIFICATION_FAILED:ENDPOINT',
      (w) =>
        w.agentClient.getAgentInfo.mockImplementation(async (e: string) =>
          infoOf(e === DEDICATED.endpoint ? 'https://other.example.com' : 'https://shared.example.com')
        )
    ],
    [
      'the new agent runs another release',
      'VERIFICATION_FAILED:RELEASE',
      (w) =>
        w.agentClient.getAgentInfo.mockImplementation(async (e: string) =>
          e === DEDICATED.endpoint
            ? { ...infoOf('https://didcomm.org.example.com'), releaseVersion: '2.0.0' }
            : infoOf('https://shared.example.com')
        )
    ],
    [
      'the new agent is configured differently',
      'VERIFICATION_FAILED:CONFIG',
      (w) =>
        w.agentClient.getAgentInfo.mockImplementation(async (e: string) => {
          const info = infoOf('https://didcomm.org.example.com');
          return e === DEDICATED.endpoint
            ? { ...info, config: { ...info.config, cronPurgeEnabled: false } }
            : infoOf('https://shared.example.com');
        })
    ],
    [
      'the credential was not signed with the org DID',
      'VERIFICATION_FAILED:SIGN_VERIFY',
      (w) => w.agentClient.createSelfAttestedCredential.mockResolvedValue({ credential: { issuer: 'did:key:other' } })
    ],
    [
      'the signed credential does not verify',
      'VERIFICATION_FAILED:SIGN_VERIFY',
      (w) => w.agentClient.verifyCredential.mockResolvedValue({ isValid: false })
    ],
    [
      'the DIDComm address cannot be reached',
      'VERIFICATION_FAILED:RELAY_PROBE',
      (w) => w.agentClient.probeRelayTarget.mockResolvedValue({ reachable: false, reason: 'TLS' })
    ],
    [
      'the org row changed since the move was prepared',
      'CUTOVER_FAILED',
      (w) => w.migrationRepository.cutover.mockRejectedValue(new ConflictException('agent row changed'))
    ]
  ];

  it.each(failures)('when %s: ends FAILED with %s and the org untouched', async (_name, code, arrange) => {
    const world = buildWorld();
    arrange(world);

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row).toMatchObject({ status: Status.FAILED, error: code });
    expect(world.world.transitions).not.toContain(Status.CUTOVER);
    expect(world.world.transitions).not.toContain(Status.STABILISING);
    orgUntouched(world.world);
    expect(isFrozen(world.world.row.status as Status)).toBe(false);
  });

  const BEFORE_THE_FREEZE_WORK = [
    'VERIFICATION_FAILED:ENDPOINT',
    'VERIFICATION_FAILED:RELEASE',
    'VERIFICATION_FAILED:CONFIG',
    'VERIFICATION_FAILED:RELAY_PROBE'
  ];

  it.each(failures.filter(([, code]) => BEFORE_THE_FREEZE_WORK.includes(code)))(
    'when %s: fails before the relay is held, anything is exported or the target is touched',
    async (_name, code, arrange) => {
      const world = buildWorld();
      arrange(world);

      await world.executor.run(MIGRATION_ID, USER_ID);

      expect(world.world.row).toMatchObject({ status: Status.FAILED, error: code });
      expect(world.agentClient.putRelay).not.toHaveBeenCalled();
      expect(world.agentClient.createImportSession).not.toHaveBeenCalled();
      expect(world.agentClient.startSealedExport).not.toHaveBeenCalled();
      expect(world.agentClient.startImport).not.toHaveBeenCalled();
    }
  );

  it.each(failures.filter(([, code]) => !['RELAY_FAILED', ...BEFORE_THE_FREEZE_WORK].includes(code)))(
    'when %s: puts the held messages back and removes the relay',
    async (_name, _code, arrange) => {
      const world = buildWorld();
      world.world.relay = 'none';
      arrange(world);

      await world.executor.run(MIGRATION_ID, USER_ID);

      expect(world.world.relay).toBe('none');
      expect(world.world.heldMessages).toBe(0);
      expect(world.calls.indexOf('reinjectRelay')).toBeGreaterThan(-1);
      expect(world.calls.indexOf('reinjectRelay')).toBeLessThan(world.calls.indexOf('deleteRelay'));
    }
  );

  it('removes the sealed export from S3 when the move fails after it started', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.exports.size).toBe(0);
  });

  it('exports nothing and imports nothing when the freeze budget has already run out', async () => {
    process.env.ORG_MIGRATION_DRAIN_MS = '30';
    const world = buildWorld({ predictedFreezeMs: 5 });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row).toMatchObject({ status: Status.FAILED, error: 'FREEZE_BUDGET_EXCEEDED' });
    expect(world.agentClient.startSealedExport).not.toHaveBeenCalled();
  });

  it('gives up with FREEZE_BUDGET_EXCEEDED when a job runs past the budget', async () => {
    const world = buildWorld({ predictedFreezeMs: 60 });
    world.agentClient.getExportJob.mockResolvedValue({ ...exportedJob, status: 'in-progress' });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row).toMatchObject({ status: Status.FAILED, error: 'FREEZE_BUDGET_EXCEEDED' });
    expect(world.world.relay).toBe('none');
  });

  it('keeps the org frozen, and stays abortable, when the held messages cannot be put back', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });
    world.agentClient.reinjectRelay.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row.status).toBe(Status.IMPORTING);
    expect(isFrozen(world.world.row.status as Status)).toBe(true);
    expect(world.world.events.map((event) => event.action)).toContain('MOVE_ABORT_INCOMPLETE');
    expect(world.world.relay).toBe('HOLD');
  });

  it('does not even try to remove the relay while the held messages could not be put back', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });
    world.agentClient.reinjectRelay.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.agentClient.deleteRelay).not.toHaveBeenCalled();
    expect(world.world.heldMessages).toBe(3);
  });

  it('finishes an incomplete abort later, once the shared agent answers again', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });
    world.agentClient.reinjectRelay.mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'));
    await world.executor.run(MIGRATION_ID, USER_ID);

    await expect(world.executor.abortInterrupted(MIGRATION_ID)).resolves.toBe(true);

    expect(world.world.row).toMatchObject({ status: Status.FAILED, error: 'MOVE_INTERRUPTED' });
    expect(world.world.relay).toBe('none');
    expect(world.world.heldMessages).toBe(0);
  });

  it('does not take a 409 for a relay that is gone: it empties the buffer again and retries the removal', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });
    world.agentClient.deleteRelay.mockImplementationOnce(async () => {
      throw new MigrationAgentError('CONFLICT', 409, 'RELAY_BUFFER_NOT_EMPTY');
    });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.agentClient.reinjectRelay).toHaveBeenCalledTimes(2);
    expect(world.agentClient.deleteRelay).toHaveBeenCalledTimes(2);
    expect(world.world.row.status).toBe(Status.FAILED);
    expect(world.world.relay).toBe('none');
  });

  it('keeps the org frozen when the relay keeps refusing removal because messages keep arriving', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });
    world.agentClient.deleteRelay.mockRejectedValue(new MigrationAgentError('CONFLICT', 409, 'RELAY_BUFFER_NOT_EMPTY'));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row.status).toBe(Status.IMPORTING);
    expect(world.world.events.map((event) => event.action)).toContain('MOVE_ABORT_INCOMPLETE');
  });

  it('leaves the abort incomplete while another re-inject is still running on the agent', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });
    world.agentClient.reinjectRelay.mockRejectedValue(new MigrationAgentError('CONFLICT', 409, 'RELAY_BUSY'));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row.status).toBe(Status.IMPORTING);
    expect(world.agentClient.deleteRelay).not.toHaveBeenCalled();
  });

  it('puts the messages back before it waits on or deletes the export', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.calls.indexOf('reinjectRelay')).toBeLessThan(world.calls.indexOf('deleteExport'));
  });

  it('waits for a running export to finish before it deletes it, and says when the delete fails', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });
    world.agentClient.getExportJob.mockResolvedValueOnce(exportedJob);
    world.agentClient.getExportJob
      .mockResolvedValueOnce({ ...exportedJob, status: 'in-progress' })
      .mockResolvedValueOnce({ ...exportedJob, status: 'in-progress' });
    world.agentClient.deleteExport.mockRejectedValue(new MigrationAgentError('NOT_FOUND', 404));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('was not deleted from S3'));
  });

  it('treats a relay entry that is already gone as cleaned up', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });
    world.agentClient.reinjectRelay.mockRejectedValue(new MigrationAgentError('NOT_FOUND', 404));
    world.agentClient.deleteRelay.mockRejectedValue(new MigrationAgentError('NOT_FOUND', 404));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row.status).toBe(Status.FAILED);
  });

  it('does not touch the relay when the move failed before it was held', async () => {
    const world = buildWorld();
    world.access.shared.mockResolvedValue(undefined);

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row).toMatchObject({ status: Status.FAILED, error: 'AGENT_UNAVAILABLE' });
    expect(world.agentClient.reinjectRelay).not.toHaveBeenCalled();
    expect(world.agentClient.deleteRelay).not.toHaveBeenCalled();
  });

  it('never logs a token or the download URL while aborting', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockRejectedValue(new MigrationAgentError('FAILED', 500));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(noSecrets(world.logger)).not.toMatch(/root-token|base-token|SECRET-SIGNATURE|ENCRYPTED-TOKEN/);
  });
});

describe('move day: how the agent gets the export', () => {
  it('has the agent pull it from S3 by default', async () => {
    const { executor, agentClient } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    expect(agentClient.startImport).toHaveBeenCalledTimes(1);
    expect(agentClient.pushImport).not.toHaveBeenCalled();
  });

  it('sends it to the agent itself when preflight found the agent cannot reach S3', async () => {
    const { executor, agentClient, world } = buildWorld({ downloadMethod: 'PUSH' });

    await executor.run(MIGRATION_ID, USER_ID);

    expect(agentClient.startImport).not.toHaveBeenCalled();
    expect(agentClient.pushImport).toHaveBeenCalledWith(
      DEDICATED.endpoint,
      DEDICATED.token,
      {
        downloadUrl: exportedJob.downloadUrl,
        sessionId: 'session-1',
        checksum: exportedJob.checksum,
        sealedStoreKey: exportedJob.sealedStoreKey,
        storageVersion: '0.5',
        dryRun: false
      },
      expect.any(Number)
    );
    expect(world.row.status).toBe(Status.STABILISING);
  });

  it('gives the transfer no more time than the freeze budget has left', async () => {
    const { executor, agentClient } = buildWorld({ downloadMethod: 'PUSH', predictedFreezeMs: 15 * MINUTE });

    await executor.run(MIGRATION_ID, USER_ID);

    const budget = agentClient.pushImport.mock.calls[0][3];
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(15 * MINUTE);
  });

  it('aborts losslessly with DOWNLOAD_FAILED when the platform cannot fetch the export', async () => {
    const { executor, agentClient, world } = buildWorld({ downloadMethod: 'PUSH' });
    agentClient.pushImport.mockRejectedValue(new MigrationAgentError('FAILED', undefined, 'DOWNLOAD_FAILED'));

    await executor.run(MIGRATION_ID, USER_ID);

    expect(world.row).toMatchObject({ status: Status.FAILED, error: 'DOWNLOAD_FAILED' });
    expect(world.relay).toBe('none');
  });
});

describe('move day: the audit trail', () => {
  it('names the owner who confirmed the move on every step it takes, and on the switch itself', async () => {
    const { executor, migrationService, migrationRepository } = buildWorld();

    await executor.run(MIGRATION_ID, USER_ID);

    const actors = migrationService.advance.mock.calls.map((call) => call[2]);
    expect(actors).toHaveLength(5);
    expect(actors.every((actor) => USER_ID === actor)).toBe(true);
    expect(migrationRepository.cutover.mock.calls[0][0].actor).toBe(USER_ID);
  });

  it('leaves a failure with no actor, so it is recorded as the system', async () => {
    const world = buildWorld();
    world.agentClient.getImportJob.mockRejectedValue(new MigrationAgentError('FAILED', 500));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.migrationService.abort.mock.calls[0][2]).toBeNull();
  });
});

describe('move day: signing check', () => {
  it('signs with an empty subject and the standard credentials context, so nothing org-specific can break it', async () => {
    const world = buildWorld();

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.agentClient.createSelfAttestedCredential).toHaveBeenCalledWith(DEDICATED.endpoint, DEDICATED.token, {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      credentialSubject: {},
      proofType: 'EcdsaSecp256k1Signature2019',
      did: ORG_DID
    });
    expect(world.agentClient.verifyCredential).toHaveBeenCalledWith(DEDICATED.endpoint, DEDICATED.token, {
      issuer: ORG_DID,
      id: 'urn:uuid:1'
    });
  });

  it.each(['did:indy:bcovrin:abc', 'did:key:z6Mk', 'did:web:org.example.com'])(
    'signs a %s with the Ed25519 suite',
    async (orgDid) => {
      const world = buildWorld({
        sourceOrgAgentSnapshot: { agentEndPoint: SHARED.endpoint, walletName: 'org-wallet', orgDid }
      });
      world.agentClient.createSelfAttestedCredential.mockResolvedValue({ credential: { issuer: orgDid } });

      await world.executor.run(MIGRATION_ID, USER_ID);

      expect(world.agentClient.createSelfAttestedCredential).toHaveBeenCalledWith(
        DEDICATED.endpoint,
        DEDICATED.token,
        expect.objectContaining({ proofType: 'Ed25519Signature2018' })
      );
      expect(world.world.row.status).toBe(Status.STABILISING);
    }
  );

  it('accepts an issuer given as an object', async () => {
    const world = buildWorld();
    world.agentClient.createSelfAttestedCredential.mockResolvedValue({ credential: { issuer: { id: ORG_DID } } });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row.status).toBe(Status.STABILISING);
  });

  it('skips the signing check for an org that has no DID, since there is no key to prove', async () => {
    const world = buildWorld({
      sourceOrgAgentSnapshot: { agentEndPoint: SHARED.endpoint, walletName: 'org-wallet', orgDid: null }
    });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.agentClient.createSelfAttestedCredential).not.toHaveBeenCalled();
    expect(world.world.row.status).toBe(Status.STABILISING);
  });
});

describe('move day: after the switch', () => {
  const switched = () => {
    const world = buildWorld({
      status: Status.CUTOVER,
      exportJobId: 'export-1',
      newInvitationDid: null,
      freezeDeadline: new Date(Date.now() - MINUTE)
    });
    world.world.relay = 'HOLD';
    world.world.exports.add('export-1');
    return world;
  };

  it('never aborts once the switch has happened, whatever fails afterwards', async () => {
    const world = buildWorld();
    world.agentClient.putRelay.mockImplementation(async (_e: string, _t: string, _tenant: string, body: any) => {
      if ('FORWARD' === body.mode) {
        throw new MigrationAgentError('UNREACHABLE');
      }
      world.world.relay = 'HOLD';
      return { mode: 'HOLD' };
    });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.migrationService.abort).not.toHaveBeenCalled();
    expect(world.world.row.status).toBe(Status.CUTOVER);
    expect(world.world.orgAgent.orgAgentTypeId).toBe('dedicated-type');
    expect(world.world.events.map((event) => event.action)).toContain('COMPLETION_STEP_FAILED');
  });

  it('retries a failing step a few times before giving up', async () => {
    const world = buildWorld();
    world.agentClient.createConnectionInvitation
      .mockRejectedValueOnce(new MigrationAgentError('FAILED', 500))
      .mockRejectedValueOnce(new MigrationAgentError('FAILED', 500));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.agentClient.createConnectionInvitation).toHaveBeenCalledTimes(3);
    expect(world.world.row.status).toBe(Status.STABILISING);
  });

  it('forwards the relay first, so held messages are not kept waiting on the invitation', async () => {
    const world = buildWorld();

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.calls.indexOf('putRelay:FORWARD')).toBeLessThan(world.calls.indexOf('createConnectionInvitation'));
  });

  it('stays frozen at CUTOVER while the invitation cannot be created, and resumes later', async () => {
    const world = buildWorld();
    world.agentClient.createConnectionInvitation.mockRejectedValue(new MigrationAgentError('FAILED', 500));
    await world.executor.run(MIGRATION_ID, USER_ID);
    expect(world.world.row.status).toBe(Status.CUTOVER);
    expect(world.world.relay).toBe('FORWARD');

    world.agentClient.createConnectionInvitation.mockResolvedValue({
      invitationUrl: 'https://didcomm.org.example.com?oob=abc',
      invitationDid: 'did:peer:2.new'
    });
    await world.executor.resumeCutover(MIGRATION_ID);

    expect(world.world.row.status).toBe(Status.STABILISING);
    expect(world.world.row.newInvitationDid).toBe('did:peer:2.new');
  });

  describe('when a step after the switch keeps failing', () => {
    const stuck = async () => {
      const world = buildWorld();
      world.agentClient.createConnectionInvitation.mockRejectedValue(new MigrationAgentError('FAILED', 500));
      await world.executor.run(MIGRATION_ID, USER_ID);
      return world;
    };

    it('says which step on the migration, so the owner and the admins can see why the org is paused', async () => {
      const world = await stuck();

      expect(world.world.row).toMatchObject({
        status: Status.CUTOVER,
        error: 'COMPLETION_STEP_FAILED:INVITATION'
      });
    });

    it('tells the owners and platform admins, naming who confirmed the move', async () => {
      const world = await stuck();

      const stuckAlerts = world.alertService.alertKeyExport.mock.calls.filter(([, kind]) => 'MOVE_STUCK' === kind);
      expect(stuckAlerts).toHaveLength(1);
      expect(stuckAlerts[0][2]).toBe(USER_ID);
    });

    it('does not say it again on every retry', async () => {
      const world = await stuck();

      await world.executor.resumeCutover(MIGRATION_ID);
      await world.executor.resumeCutover(MIGRATION_ID);

      const stuckAlerts = world.alertService.alertKeyExport.mock.calls.filter(([, kind]) => 'MOVE_STUCK' === kind);
      expect(stuckAlerts).toHaveLength(1);
      expect(world.world.events.filter((event) => 'COMPLETION_STEP_FAILED' === event.action)).toHaveLength(1);
    });

    it('says it again when a different step is the one that fails', async () => {
      const world = await stuck();
      world.agentClient.createConnectionInvitation.mockResolvedValue({
        invitationUrl: 'https://didcomm.org.example.com?oob=abc',
        invitationDid: 'did:peer:2.new'
      });
      world.agentClient.putRelay.mockRejectedValue(new MigrationAgentError('FAILED', 500));
      world.world.row.newInvitationDid = null;

      await world.executor.resumeCutover(MIGRATION_ID);

      expect(world.world.row.error).toBe('COMPLETION_STEP_FAILED:RELAY_FORWARD');
      expect(world.alertService.alertKeyExport.mock.calls.filter(([, kind]) => 'MOVE_STUCK' === kind)).toHaveLength(2);
    });

    it('clears the note once the move finishes', async () => {
      const world = await stuck();
      world.agentClient.createConnectionInvitation.mockResolvedValue({
        invitationUrl: 'https://didcomm.org.example.com?oob=abc',
        invitationDid: 'did:peer:2.new'
      });

      await world.executor.resumeCutover(MIGRATION_ID);

      expect(world.world.row).toMatchObject({ status: Status.STABILISING, error: null });
    });

    it('carries on when the alert cannot be sent, and does not mark the step as reported', async () => {
      const world = buildWorld();
      world.agentClient.createConnectionInvitation.mockRejectedValue(new MigrationAgentError('FAILED', 500));
      world.alertService.alertKeyExport.mockImplementation(async (_m, kind) => {
        if ('MOVE_STUCK' === kind) {
          throw new Error('mail down');
        }
        return { recipients: 1, sent: 1 };
      });

      await world.executor.run(MIGRATION_ID, USER_ID);

      expect(world.world.row.status).toBe(Status.CUTOVER);
      expect(world.world.row.error).not.toBe('COMPLETION_STEP_FAILED:INVITATION');
    });

    it.each([
      ['throws', () => Promise.reject(new Error('mail down'))],
      ['reaches nobody', () => Promise.resolve({ recipients: 2, sent: 0 })]
    ])('tries the alert again on the next resume when it %s, instead of staying silent', async (_name, failing) => {
      const world = buildWorld();
      world.agentClient.createConnectionInvitation.mockRejectedValue(new MigrationAgentError('FAILED', 500));
      const stuckKinds = () =>
        world.alertService.alertKeyExport.mock.calls.filter(([, kind]) => 'MOVE_STUCK' === kind).length;
      world.alertService.alertKeyExport.mockImplementation(async (_m, kind) =>
        'MOVE_STUCK' === kind ? failing() : { recipients: 1, sent: 1 }
      );
      await world.executor.run(MIGRATION_ID, USER_ID);
      expect(stuckKinds()).toBe(1);

      world.alertService.alertKeyExport.mockImplementation(async () => ({ recipients: 1, sent: 1 }));
      await world.executor.resumeCutover(MIGRATION_ID);

      expect(stuckKinds()).toBe(2);
      expect(world.world.row.error).toBe('COMPLETION_STEP_FAILED:INVITATION');
    });

    it('does not mark the migration when only the S3 cleanup fails, which never holds the org', async () => {
      const world = buildWorld();
      world.agentClient.deleteExport.mockRejectedValue(new MigrationAgentError('FAILED', 500));

      await world.executor.run(MIGRATION_ID, USER_ID);

      expect(world.world.row.error).toBeNull();
    });
  });

  it('does not wait on the S3 cleanup to unfreeze the org', async () => {
    const world = buildWorld();
    world.agentClient.deleteExport.mockRejectedValue(new MigrationAgentError('FAILED', 500));

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.world.row.status).toBe(Status.STABILISING);
  });

  it('resumes a switched-over move from the stored state, without making a second invitation', async () => {
    const world = switched();
    world.world.row.newInvitationDid = 'did:peer:2.already';

    await world.executor.resumeCutover(MIGRATION_ID);

    expect(world.agentClient.createConnectionInvitation).not.toHaveBeenCalled();
    expect(world.world.relay).toBe('FORWARD');
    expect(world.world.exports.size).toBe(0);
    expect(world.world.row.status).toBe(Status.STABILISING);
  });

  it('resumes as the owner who confirmed the move, and as whoever started it when none is on record', async () => {
    const confirmed = switched();
    confirmed.world.confirmingActor = 'owner-2';
    await confirmed.executor.resumeCutover(MIGRATION_ID);
    expect(confirmed.migrationService.advance.mock.calls.at(-1)?.[2]).toBe('owner-2');

    const unrecorded = switched();
    await unrecorded.executor.resumeCutover(MIGRATION_ID);
    expect(unrecorded.migrationService.advance.mock.calls.at(-1)?.[2]).toBe(USER_ID);
  });

  it('resumes a switched-over move that never made its invitation', async () => {
    const world = switched();

    await world.executor.resumeCutover(MIGRATION_ID);

    expect(world.world.row).toMatchObject({ status: Status.STABILISING, newInvitationDid: 'did:peer:2.new' });
  });

  it.each([Status.FROZEN, Status.VERIFYING, Status.STABILISING, Status.COMPLETED, Status.FAILED])(
    'will not resume a move that is in %s',
    async (status) => {
      const world = buildWorld({ status });

      await world.executor.resumeCutover(MIGRATION_ID);

      expect(world.agentClient.putRelay).not.toHaveBeenCalled();
    }
  );

  it('carries on instead of aborting when the switch committed but its answer was lost', async () => {
    const world = buildWorld();
    world.migrationRepository.cutover.mockImplementationOnce(async (params: any) => {
      Object.assign(world.world.orgAgent, {
        orgAgentTypeId: 'dedicated-type',
        agentEndPoint: params.agentEndPoint,
        tenantId: null
      });
      world.world.row.status = Status.CUTOVER;
      world.world.transitions.push(Status.CUTOVER);
      throw new Error('connection reset after commit');
    });

    await world.executor.run(MIGRATION_ID, USER_ID);

    expect(world.migrationService.abort).not.toHaveBeenCalled();
    expect(world.world.row.status).toBe(Status.STABILISING);
    expect(world.world.orgAgent.orgAgentTypeId).toBe('dedicated-type');
  });
});

describe('move day: an interrupted move', () => {
  it.each([Status.FROZEN, Status.EXPORTING, Status.IMPORTING, Status.VERIFYING])(
    'is undone from %s: relay released, messages re-injected, export removed, FAILED',
    async (status) => {
      const world = buildWorld({ status, exportJobId: 'export-1' });
      world.world.relay = 'HOLD';
      world.world.exports.add('export-1');

      await expect(world.executor.abortInterrupted(MIGRATION_ID)).resolves.toBe(true);

      expect(world.world.row).toMatchObject({ status: Status.FAILED, error: 'MOVE_INTERRUPTED' });
      expect(world.world.relay).toBe('none');
      expect(world.world.heldMessages).toBe(0);
      expect(world.world.exports.size).toBe(0);
    }
  );

  it('uses the code it is given', async () => {
    const world = buildWorld({ status: Status.EXPORTING });
    world.world.relay = 'HOLD';

    await world.executor.abortInterrupted(MIGRATION_ID, 'FREEZE_BUDGET_EXCEEDED');

    expect(world.world.row.error).toBe('FREEZE_BUDGET_EXCEEDED');
  });

  it('copes with a relay that was never set', async () => {
    const world = buildWorld({ status: Status.FROZEN });
    world.agentClient.reinjectRelay.mockRejectedValue(new MigrationAgentError('NOT_FOUND', 404));

    await expect(world.executor.abortInterrupted(MIGRATION_ID)).resolves.toBe(true);

    expect(world.world.row.status).toBe(Status.FAILED);
  });

  it('refuses to abort a move that has already switched over, and finishes it instead', async () => {
    const world = buildWorld({ status: Status.CUTOVER, exportJobId: 'export-1' });
    world.world.relay = 'HOLD';

    await expect(world.executor.abortInterrupted(MIGRATION_ID)).resolves.toBe(false);

    expect(world.migrationService.abort).not.toHaveBeenCalled();
    expect(world.world.row.status).toBe(Status.STABILISING);
  });

  it('does nothing for a migration that is not there', async () => {
    const world = buildWorld();
    world.migrationRepository.getById.mockResolvedValue(null);

    await expect(world.executor.abortInterrupted(MIGRATION_ID)).resolves.toBe(false);
  });
});
