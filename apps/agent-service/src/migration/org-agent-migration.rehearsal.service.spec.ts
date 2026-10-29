/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-explicit-any, prefer-destructuring, no-mixed-operators */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { createHash } from 'crypto';
import { MigrationAgentError } from './migration-agent.client';
import { OrgAgentMigrationRehearsalService, predictFreezeMs } from './org-agent-migration.rehearsal.service';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';
const MIGRATION_ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';
const MINUTE = 60 * 1000;
const PUBLIC_KEY = Buffer.from('import-public-key-bytes').toString('base64');

const SHARED = { endpoint: 'https://shared.example.com', token: 'base-token' };
const DEDICATED = { endpoint: 'https://admin.org.example.com', token: 'root-token' };

const migrationRow = (overrides = {}) => ({
  id: MIGRATION_ID,
  orgId: ORG_ID,
  status: Status.CREATED,
  tenantId: 'tenant-1',
  targetTokenEncrypted: 'stored',
  preflight: { passed: true, checks: [] },
  ...overrides
});

const completedExport = {
  jobId: 'export-1',
  status: 'completed',
  downloadUrl: 'https://bucket.s3.amazonaws.com/wallet-exports/t/e.db.gz?sig=SECRET-SIGNATURE',
  checksum: 'a'.repeat(64),
  sealedStoreKey: 'c2VhbGVk',
  storageVersion: '0.5'
};
const completedImport = {
  jobId: 'import-1',
  status: 'completed',
  counts: { entries: 120, keys: 4, skipped: 1 }
};

const build = (options: { migration?: object | null } = {}) => {
  const migration = 'migration' in options ? options.migration : migrationRow();
  const migrationRepository = {
    getActiveByOrgId: jest.fn().mockResolvedValue(migration),
    getById: jest.fn().mockResolvedValue(migration && { ...migration, rehearsalStatus: 'RUNNING' }),
    tryStartRehearsal: jest.fn().mockResolvedValue(true),
    touchRehearsal: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({})
  };
  const migrationService = { advance: jest.fn().mockResolvedValue({}) };
  const access = {
    shared: jest.fn().mockResolvedValue(SHARED),
    dedicated: jest.fn().mockResolvedValue(DEDICATED)
  };
  const calls: string[] = [];
  const track = <T>(name: string, value: T) =>
    jest.fn().mockImplementation(async () => {
      calls.push(name);
      return value;
    });
  const agentClient = {
    createImportSession: track('createImportSession', { sessionId: 'session-1', importPublicKey: PUBLIC_KEY }),
    startSealedExport: track('startSealedExport', { jobId: 'export-1', status: 'pending' }),
    getExportJob: track('getExportJob', completedExport),
    startImport: track('startImport', { jobId: 'import-1', status: 'pending' }),
    getImportJob: track('getImportJob', completedImport),
    deleteExport: track('deleteExport', undefined)
  };
  const logger = { error: jest.fn(), warn: jest.fn() };
  const service = new OrgAgentMigrationRehearsalService(
    migrationRepository as never,
    migrationService as never,
    access as never,
    agentClient as never,
    logger as never
  );
  const execute = (row = migrationRow()) => (service as any).execute(row, USER_ID) as Promise<void>;
  return { service, migrationRepository, migrationService, access, agentClient, logger, calls, execute };
};

const failureRecorded = (migrationRepository: { update: jest.Mock }) =>
  migrationRepository.update.mock.calls.map(([, patch]) => patch).find((patch) => 'FAILED' === patch.rehearsalStatus);

beforeEach(() => {
  process.env.ORG_MIGRATION_POLL_INTERVAL_MS = '1';
});

afterEach(() => {
  delete process.env.ORG_MIGRATION_POLL_INTERVAL_MS;
  delete process.env.ORG_MIGRATION_JOB_TIMEOUT_MS;
  delete process.env.ORG_MIGRATION_EXPORT_CLEANUP_WAIT_MS;
});

describe('predictFreezeMs', () => {
  it.each([
    [Number(MINUTE), 15 * MINUTE],
    [10 * MINUTE, 15 * MINUTE],
    [20 * MINUTE, 30 * MINUTE],
    [60 * MINUTE, 90 * MINUTE],
    [100 * MINUTE, 120 * MINUTE],
    [600 * MINUTE, 120 * MINUTE]
  ])('a %i ms rehearsal predicts %i ms', (rehearsal, predicted) => {
    expect(predictFreezeMs(rehearsal)).toBe(predicted);
  });
});

describe('OrgAgentMigrationRehearsalService.start', () => {
  it('starts the rehearsal in the background and returns the migration marked as running', async () => {
    const { service, migrationRepository } = build();
    const execute = jest.spyOn(service as any, 'execute').mockResolvedValue(undefined);

    const result = await service.start(ORG_ID, USER_ID);

    expect(result).toMatchObject({ id: MIGRATION_ID, rehearsalStatus: 'RUNNING' });
    expect(migrationRepository.tryStartRehearsal).toHaveBeenCalledWith(MIGRATION_ID, expect.any(Date));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: MIGRATION_ID }), USER_ID);
  });

  it('treats a rehearsal that has not shown a sign of life for three minutes as dead', async () => {
    const { service, migrationRepository } = build();
    jest.spyOn(service as any, 'execute').mockResolvedValue(undefined);

    await service.start(ORG_ID, USER_ID);

    const [, staleBefore] = migrationRepository.tryStartRehearsal.mock.calls[0];
    expect(Date.now() - staleBefore.getTime()).toBeGreaterThanOrEqual(3 * MINUTE - 1000);
    expect(Date.now() - staleBefore.getTime()).toBeLessThan(4 * MINUTE);
  });

  it('can be run again on a rehearsed migration', async () => {
    const { service } = build({ migration: migrationRow({ status: Status.REHEARSED }) });
    jest.spyOn(service as any, 'execute').mockResolvedValue(undefined);

    await expect(service.start(ORG_ID, USER_ID)).resolves.toBeDefined();
  });

  it('refuses when the org has no active migration', async () => {
    const { service } = build({ migration: null });

    await expect(service.start(ORG_ID, USER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([Status.FROZEN, Status.EXPORTING, Status.CUTOVER, Status.STABILISING])(
    'refuses a migration in %s',
    async (status) => {
      const { service, migrationRepository } = build({ migration: migrationRow({ status }) });

      await expect(service.start(ORG_ID, USER_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(migrationRepository.tryStartRehearsal).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['no preflight has run', { preflight: null }],
    ['the last preflight failed', { preflight: { passed: false, checks: [] } }],
    ['there is no stored token', { targetTokenEncrypted: null }],
    ['the org has no tenant', { tenantId: null }]
  ])('refuses when %s', async (_name, overrides) => {
    const { service, migrationRepository } = build({ migration: migrationRow(overrides) });

    await expect(service.start(ORG_ID, USER_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(migrationRepository.tryStartRehearsal).not.toHaveBeenCalled();
  });

  it('refuses while another rehearsal is running', async () => {
    const { service, migrationRepository } = build();
    migrationRepository.tryStartRehearsal.mockResolvedValue(false);

    await expect(service.start(ORG_ID, USER_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OrgAgentMigrationRehearsalService heartbeat', () => {
  afterEach(() => {
    delete process.env.ORG_MIGRATION_REHEARSAL_HEARTBEAT_MS;
  });

  it('shows the rehearsal alive while it runs, and stops once it is over', async () => {
    process.env.ORG_MIGRATION_REHEARSAL_HEARTBEAT_MS = '10';
    const { execute, migrationRepository, agentClient } = build();
    agentClient.startSealedExport.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { jobId: 'export-1', status: 'pending' };
    });

    await execute();
    const during = migrationRepository.touchRehearsal.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(during).toBeGreaterThanOrEqual(3);
    expect(migrationRepository.touchRehearsal).toHaveBeenCalledTimes(during);
    expect(migrationRepository.touchRehearsal).toHaveBeenCalledWith(MIGRATION_ID);
  });

  it('stops the heartbeat when the rehearsal fails', async () => {
    process.env.ORG_MIGRATION_REHEARSAL_HEARTBEAT_MS = '10';
    const { execute, migrationRepository, agentClient } = build();
    agentClient.createImportSession.mockRejectedValue(new Error('down'));

    await execute();
    const afterFailure = migrationRepository.touchRehearsal.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(migrationRepository.touchRehearsal).toHaveBeenCalledTimes(afterFailure);
  });
});

describe('OrgAgentMigrationRehearsalService rehearsal run', () => {
  it('exports sealed to the dedicated agent, dry-runs the import there, then removes the export', async () => {
    const { calls, execute, agentClient } = build();

    await execute();

    expect(calls).toEqual([
      'createImportSession',
      'startSealedExport',
      'getExportJob',
      'startImport',
      'getImportJob',
      'getExportJob',
      'deleteExport'
    ]);
    expect(agentClient.startSealedExport).toHaveBeenCalledWith(SHARED.endpoint, SHARED.token, 'tenant-1', PUBLIC_KEY);
    expect(agentClient.startImport).toHaveBeenCalledWith(DEDICATED.endpoint, DEDICATED.token, {
      sessionId: 'session-1',
      exportUrl: completedExport.downloadUrl,
      checksum: completedExport.checksum,
      sealedStoreKey: completedExport.sealedStoreKey,
      storageVersion: '0.5',
      dryRun: true
    });
    expect(agentClient.deleteExport).toHaveBeenCalledWith(SHARED.endpoint, SHARED.token, 'tenant-1', 'export-1');
  });

  it('moves the migration to REHEARSED, recording counts, timings, the prediction and the import key fingerprint', async () => {
    const { execute, migrationService } = build();

    await execute();

    expect(migrationService.advance).toHaveBeenCalledWith(
      MIGRATION_ID,
      Status.REHEARSED,
      USER_ID,
      expect.objectContaining({
        counts: completedImport.counts,
        exportJobId: 'export-1',
        importJobId: 'import-1',
        importKeyFingerprint: createHash('sha256').update(Buffer.from(PUBLIC_KEY, 'base64')).digest('hex'),
        storageVersion: '0.5',
        rehearsalStatus: 'DONE',
        predictedFreezeMs: 15 * MINUTE,
        rehearsal: expect.objectContaining({ downloadMethod: 'PULL', exportCleanup: 'DELETED' })
      })
    );
    const [, , , patch] = migrationService.advance.mock.calls[0];
    expect(patch.rehearsalDurationMs).toBeGreaterThanOrEqual(0);
    expect(patch.rehearsal.exportMs + patch.rehearsal.importMs).toBe(patch.rehearsalDurationMs);
  });

  it('waits for a job that is still running', async () => {
    const { execute, agentClient } = build();
    agentClient.getExportJob
      .mockResolvedValueOnce({ ...completedExport, status: 'pending' })
      .mockResolvedValueOnce({ ...completedExport, status: 'in-progress' })
      .mockResolvedValueOnce(completedExport);

    await execute();

    expect(agentClient.getExportJob).toHaveBeenCalledTimes(4);
    expect(agentClient.startImport).toHaveBeenCalledTimes(1);
  });

  it('keeps the migration where it was and records a failed export, removing nothing that was never made', async () => {
    const { execute, migrationRepository, migrationService, agentClient } = build();
    agentClient.getExportJob.mockResolvedValue({ ...completedExport, status: 'failed' });

    await execute();

    expect(migrationService.advance).not.toHaveBeenCalled();
    expect(failureRecorded(migrationRepository)).toMatchObject({
      rehearsal: expect.objectContaining({ step: 'EXPORT', code: 'EXPORT_FAILED' })
    });
    expect(agentClient.startImport).not.toHaveBeenCalled();
    expect(agentClient.deleteExport).toHaveBeenCalledTimes(1);
  });

  it('records a failed import and still removes the export from S3', async () => {
    const { execute, migrationRepository, migrationService, agentClient } = build();
    agentClient.getImportJob.mockResolvedValue({ jobId: 'import-1', status: 'failed' });

    await execute();

    expect(migrationService.advance).not.toHaveBeenCalled();
    expect(failureRecorded(migrationRepository)).toMatchObject({
      rehearsal: expect.objectContaining({ step: 'IMPORT', code: 'IMPORT_FAILED', exportCleanup: 'DELETED' })
    });
    expect(agentClient.deleteExport).toHaveBeenCalledWith(SHARED.endpoint, SHARED.token, 'tenant-1', 'export-1');
  });

  it.each(['TARGET_NOT_PRISTINE', 'STORAGE_VERSION_MISMATCH'])('reports %s from the agent by name', async (code) => {
    const { execute, migrationRepository, agentClient } = build();
    agentClient.startImport.mockRejectedValue(new MigrationAgentError('CONFLICT', 409, code));

    await execute();

    expect(failureRecorded(migrationRepository)).toMatchObject({
      rehearsal: expect.objectContaining({ step: 'IMPORT', code })
    });
    expect(agentClient.deleteExport).toHaveBeenCalledTimes(1);
  });

  it('exports nothing when the target is not pristine', async () => {
    const { execute, migrationRepository, agentClient } = build();
    agentClient.createImportSession.mockRejectedValue(new MigrationAgentError('CONFLICT', 409, 'TARGET_NOT_PRISTINE'));

    await execute();

    expect(agentClient.startSealedExport).not.toHaveBeenCalled();
    expect(agentClient.deleteExport).not.toHaveBeenCalled();
    expect(failureRecorded(migrationRepository)).toMatchObject({
      rehearsal: expect.objectContaining({ code: 'TARGET_NOT_PRISTINE' })
    });
  });

  it('gives up with a timeout when a job never finishes', async () => {
    process.env.ORG_MIGRATION_JOB_TIMEOUT_MS = '20';
    process.env.ORG_MIGRATION_EXPORT_CLEANUP_WAIT_MS = '20';
    const { execute, migrationRepository, agentClient } = build();
    agentClient.getExportJob.mockResolvedValue({ ...completedExport, status: 'in-progress' });

    await execute();

    expect(failureRecorded(migrationRepository)).toMatchObject({
      rehearsal: expect.objectContaining({ step: 'EXPORT', code: 'REHEARSAL_TIMEOUT' })
    });
    expect(agentClient.deleteExport).toHaveBeenCalledTimes(1);
  });

  it('waits for a running export to settle before it deletes it', async () => {
    const { service, agentClient, calls } = build();
    agentClient.getExportJob
      .mockResolvedValueOnce({ ...completedExport, status: 'in-progress' })
      .mockResolvedValueOnce({ ...completedExport, status: 'in-progress' })
      .mockResolvedValue(completedExport);

    await expect((service as any).deleteExport(SHARED, 'tenant-1', 'export-1')).resolves.toBe('DELETED');

    expect(agentClient.getExportJob).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(['deleteExport']);
  });

  it('keeps the id of an export it could not delete, so a later run can remove it', async () => {
    process.env.ORG_MIGRATION_JOB_TIMEOUT_MS = '20';
    process.env.ORG_MIGRATION_EXPORT_CLEANUP_WAIT_MS = '20';
    const { execute, migrationRepository, agentClient } = build();
    agentClient.getExportJob.mockResolvedValue({ ...completedExport, status: 'in-progress' });
    agentClient.deleteExport.mockRejectedValue(new MigrationAgentError('CONFLICT', 409));

    await execute();

    expect(failureRecorded(migrationRepository)).toMatchObject({
      exportJobId: 'export-1',
      rehearsal: expect.objectContaining({ code: 'REHEARSAL_TIMEOUT', exportCleanup: 'FAILED' })
    });
  });

  it('tolerates two failed polls in a row, but not three', async () => {
    const tolerated = build();
    tolerated.agentClient.getExportJob
      .mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'))
      .mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'))
      .mockResolvedValueOnce(completedExport);
    await tolerated.execute();
    expect(tolerated.migrationService.advance).toHaveBeenCalled();

    const gaveUp = build();
    gaveUp.agentClient.getExportJob.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));
    await gaveUp.execute();
    expect(gaveUp.migrationService.advance).not.toHaveBeenCalled();
    expect(failureRecorded(gaveUp.migrationRepository)).toMatchObject({
      rehearsal: expect.objectContaining({ code: 'AGENT_UNREACHABLE' })
    });
  });

  it('still succeeds when the export could not be deleted, and says so', async () => {
    const { execute, migrationService, agentClient, logger } = build();
    agentClient.deleteExport.mockRejectedValue(new MigrationAgentError('FAILED', 500));

    await execute();

    expect(migrationService.advance.mock.calls[0][3].rehearsal).toMatchObject({ exportCleanup: 'FAILED' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('records that the agents were unavailable when the stored credentials cannot be decrypted', async () => {
    const { execute, access, migrationRepository, agentClient } = build();
    access.dedicated.mockRejectedValue(new BadRequestException('decrypt failed'));

    await execute();

    expect(failureRecorded(migrationRepository)).toMatchObject({
      rehearsal: expect.objectContaining({ code: 'AGENT_UNAVAILABLE' })
    });
    expect(agentClient.createImportSession).not.toHaveBeenCalled();
  });

  it('records that the agents were unavailable when no credentials can be found', async () => {
    const { execute, access, migrationRepository, agentClient } = build();
    access.dedicated.mockResolvedValue(undefined);

    await execute();

    expect(failureRecorded(migrationRepository)).toMatchObject({
      rehearsal: expect.objectContaining({ code: 'AGENT_UNAVAILABLE' })
    });
    expect(agentClient.createImportSession).not.toHaveBeenCalled();
  });

  it('never logs the download URL, a token or the sealed key', async () => {
    const { execute, logger, agentClient } = build();
    agentClient.deleteExport.mockRejectedValue(new MigrationAgentError('FAILED', 500));

    await execute();

    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toMatch(/SECRET-SIGNATURE|root-token|base-token|c2VhbGVk/);
  });
});
