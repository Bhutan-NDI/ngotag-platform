/* eslint-disable camelcase */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';
import { ResponseMessages } from '@credebl/common/response-messages';
import { org_agent_migrations } from '@prisma/client';
import { createHash } from 'crypto';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { IAgentAccess, MigrationAgentAccess } from './migration-agent-access';
import { envMs, JobPollFailure, jobTimeoutMs, pollJob } from './migration-job-poller';
import { IPortabilityJob, MigrationAgentClient, MigrationAgentError } from './migration-agent.client';
import { DownloadMethod, IPreflightReport, IRehearsalRecord } from './org-agent-migration.interface';
import { KeyExportAlertKind, OrgAgentMigrationAlertService } from './org-agent-migration.alert.service';
import { OrgAgentMigrationService } from './org-agent-migration.service';

const MINUTE_MS = 60 * 1000;
const FREEZE_FACTOR = 1.5;
const FREEZE_FLOOR_MS = 15 * MINUTE_MS;
const FREEZE_CAP_MS = 120 * MINUTE_MS;

/** The pause to promise the owner, and the budget the move gets: 1.5 x the rehearsal, between 15 and 120 minutes. */
export const predictFreezeMs = (rehearsalDurationMs: number): number =>
  Math.min(FREEZE_CAP_MS, Math.max(FREEZE_FLOOR_MS, Math.round(rehearsalDurationMs * FREEZE_FACTOR)));

// Stable codes the studio maps to a message; never raw error text.
class RehearsalFailure extends Error {
  constructor(
    readonly step: 'EXPORT' | 'IMPORT',
    readonly code: string
  ) {
    super(code);
  }
}

interface ICustodyFacts {
  checksum?: string;
  importKeyFingerprint?: string;
}

/**
 * The dry run of a move (SAD E.2): export the tenant sealed to the dedicated agent, merge it there with the merge
 * rolled back, time both, and remove the export from S3. Nothing on either agent changes and the org is never
 * frozen. It runs in the background because a large wallet takes minutes; the owner polls the migration.
 *
 * The rehearsal is a real export of the org's keys, so the controls that guard every export apply to it too.
 */
@Injectable()
export class OrgAgentMigrationRehearsalService {
  constructor(
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly migrationService: OrgAgentMigrationService,
    private readonly access: MigrationAgentAccess,
    private readonly agentClient: MigrationAgentClient,
    private readonly alertService: OrgAgentMigrationAlertService,
    private readonly logger: Logger
  ) {}

  /**
   * Starts the rehearsal and returns at once with the migration marked as running.
   * @throws when the migration is not ready for one, or one is already running
   */
  async start(orgId: string, actor: string): Promise<org_agent_migrations> {
    const migration = await this.migrationRepository.getActiveByOrgId(orgId);
    if (!migration) {
      throw new NotFoundException(ResponseMessages.agent.error.migrationNotFound);
    }
    if (![OrgAgentMigrationStatus.CREATED, OrgAgentMigrationStatus.REHEARSED].includes(migration.status as never)) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationInvalidTransition);
    }
    if (!(migration.preflight as unknown as IPreflightReport | null)?.passed) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationPreflightNotPassed);
    }
    if (!migration.tenantId || !migration.targetTokenEncrypted) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationPreflightNotPassed);
    }

    const staleBefore = new Date(Date.now() - envMs('ORG_MIGRATION_REHEARSAL_MAX_MS', 3 * 60 * MINUTE_MS));
    if (!(await this.migrationRepository.tryStartRehearsal(migration.id, staleBefore))) {
      throw new ConflictException(ResponseMessages.agent.error.migrationRehearsalRunning);
    }

    // The rehearsal is a real export of the org's keys, so the alert goes out first and is not optional: if nobody
    // could be told, the export does not run.
    const alert = await this.alertService.alertKeyExport(migration, KeyExportAlertKind.REHEARSAL_EXPORT, actor);
    await this.audit(migration.id, actor, 'REHEARSAL_STARTED', {
      alertsSent: alert.sent,
      recipients: alert.recipients
    });
    if (1 > alert.sent) {
      await this.recordFailure(migration.id, actor, { code: 'ALERT_FAILED' });
      throw new ServiceUnavailableException(ResponseMessages.agent.error.migrationAlertFailed);
    }

    void this.execute(migration, actor).catch((error) => {
      this.logger.error(`[rehearsal] ${migration.id} crashed: ${error instanceof Error ? error.message : 'failed'}`);
    });
    return this.migrationRepository.getById(migration.id) as Promise<org_agent_migrations>;
  }

  private async execute(migration: org_agent_migrations, actor: string): Promise<void> {
    const shared = await this.access.shared();
    const dedicated = await this.access.dedicated(migration);
    if (!shared || !dedicated) {
      await this.recordFailure(migration.id, actor, { code: 'AGENT_UNAVAILABLE' });
      return;
    }

    const downloadMethod: DownloadMethod = 'PUSH' === migration.downloadMethod ? 'PUSH' : 'PULL';
    const record: IRehearsalRecord = { downloadMethod };
    await this.removeLeftoverExport(migration, shared);
    // Audited whether the rehearsal finishes or not: the export has happened as soon as they are known.
    const custody: ICustodyFacts = {};
    let exportJobId: string | undefined;
    try {
      const session = await this.guard('IMPORT', () =>
        this.agentClient.createImportSession(dedicated.endpoint, dedicated.token)
      );
      const importKeyFingerprint = createHash('sha256')
        .update(Buffer.from(session.importPublicKey, 'base64'))
        .digest('hex');
      custody.importKeyFingerprint = importKeyFingerprint;

      const exportStarted = Date.now();
      const exportJob = await this.guard('EXPORT', () =>
        this.agentClient.startSealedExport(shared.endpoint, shared.token, migration.tenantId, session.importPublicKey)
      );
      exportJobId = exportJob.jobId;
      // Kept at once, so an export left behind by a crash can be found and removed by the next rehearsal.
      await this.migrationRepository.update(migration.id, { exportJobId });
      const exported = await this.waitFor('EXPORT', () =>
        this.agentClient.getExportJob(shared.endpoint, shared.token, migration.tenantId, exportJob.jobId)
      );
      record.exportMs = Date.now() - exportStarted;
      custody.checksum = exported.checksum;

      const importStarted = Date.now();
      const importJob = await this.guard('IMPORT', () =>
        'PUSH' === downloadMethod
          ? this.agentClient.pushImport(dedicated.endpoint, dedicated.token, {
              downloadUrl: exported.downloadUrl,
              sessionId: session.sessionId,
              checksum: exported.checksum,
              sealedStoreKey: exported.sealedStoreKey,
              storageVersion: exported.storageVersion,
              dryRun: true
            })
          : this.agentClient.startImport(dedicated.endpoint, dedicated.token, {
              sessionId: session.sessionId,
              exportUrl: exported.downloadUrl,
              checksum: exported.checksum,
              sealedStoreKey: exported.sealedStoreKey,
              storageVersion: exported.storageVersion,
              dryRun: true
            })
      );
      const imported = await this.waitFor('IMPORT', () =>
        this.agentClient.getImportJob(dedicated.endpoint, dedicated.token, importJob.jobId)
      );
      record.importMs = Date.now() - importStarted;

      const rehearsalDurationMs = record.exportMs + record.importMs;
      record.exportCleanup = await this.deleteExport(shared, migration.tenantId, exportJobId);
      exportJobId = undefined;
      record.finishedAt = new Date().toISOString();

      await this.migrationService.advance(migration.id, OrgAgentMigrationStatus.REHEARSED, actor, {
        counts: imported.counts as never,
        rehearsalDurationMs,
        predictedFreezeMs: predictFreezeMs(rehearsalDurationMs),
        exportJobId: exportJob.jobId,
        importJobId: importJob.jobId,
        importKeyFingerprint,
        storageVersion: exported.storageVersion,
        rehearsalStatus: 'DONE',
        rehearsal: record as never
      });
      await this.audit(migration.id, actor, 'REHEARSAL_FINISHED', {
        outcome: 'DONE',
        exportCleanup: record.exportCleanup ?? 'DELETED',
        ...custody
      });
    } catch (error) {
      if (exportJobId) {
        record.exportCleanup = await this.deleteExport(shared, migration.tenantId, exportJobId);
      }
      const failure = error instanceof RehearsalFailure ? error : new RehearsalFailure('EXPORT', 'REHEARSAL_FAILED');
      await this.recordFailure(migration.id, actor, { ...record, step: failure.step, code: failure.code }, custody);
    }
  }

  // Maps an agent failure to the code the owner sees and which step it came from.
  private async guard<T>(step: 'EXPORT' | 'IMPORT', call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new RehearsalFailure(step, this.failureCode(step, error));
    }
  }

  private failureCode(step: 'EXPORT' | 'IMPORT', error: unknown): string {
    if (error instanceof MigrationAgentError) {
      if ('CONFLICT' === error.kind && ['TARGET_NOT_PRISTINE', 'STORAGE_VERSION_MISMATCH'].includes(error.agentCode)) {
        return error.agentCode;
      }
      if ('DOWNLOAD_FAILED' === error.agentCode) {
        return 'DOWNLOAD_FAILED';
      }
      if ('REJECTED' === error.kind) {
        return 'AGENT_TOKEN_REJECTED';
      }
      if ('UNREACHABLE' === error.kind) {
        return 'AGENT_UNREACHABLE';
      }
    }
    return `${step}_FAILED`;
  }

  // Polls a job to completion, mapping why it gave up onto the step it belongs to.
  private async waitFor(step: 'EXPORT' | 'IMPORT', fetchJob: () => Promise<IPortabilityJob>): Promise<IPortabilityJob> {
    try {
      return await pollJob(fetchJob, Date.now() + jobTimeoutMs());
    } catch (error) {
      if (error instanceof JobPollFailure) {
        if ('JOB_FAILED' === error.reason) {
          throw new RehearsalFailure(step, `${step}_FAILED`);
        }
        throw new RehearsalFailure(
          step,
          'TIMEOUT' === error.reason ? 'REHEARSAL_TIMEOUT' : this.failureCode(step, error.cause)
        );
      }
      throw error;
    }
  }

  // An export an earlier rehearsal started and never cleaned up, because the process stopped part way.
  private async removeLeftoverExport(migration: org_agent_migrations, shared: IAgentAccess): Promise<void> {
    if (migration.exportJobId) {
      await this.deleteExport(shared, migration.tenantId, migration.exportJobId);
    }
  }

  private async deleteExport(shared: IAgentAccess, tenantId: string, jobId: string): Promise<'DELETED' | 'FAILED'> {
    try {
      await this.agentClient.deleteExport(shared.endpoint, shared.token, tenantId, jobId);
      return 'DELETED';
    } catch (error) {
      this.logger.warn(
        `[rehearsal] export ${jobId} was not deleted from S3: ${error instanceof Error ? error.message : 'failed'}`
      );
      return 'FAILED';
    }
  }

  private async recordFailure(
    migrationId: string,
    actor: string,
    record: IRehearsalRecord & { code: string },
    custody: ICustodyFacts = {}
  ): Promise<void> {
    try {
      await this.migrationRepository.update(migrationId, {
        rehearsalStatus: 'FAILED',
        rehearsal: { ...record, finishedAt: new Date().toISOString() } as never
      });
    } catch (error) {
      this.logger.error(`[rehearsal] could not record failure: ${error instanceof Error ? error.message : 'failed'}`);
    }
    await this.audit(migrationId, actor, 'REHEARSAL_FINISHED', {
      outcome: 'FAILED',
      code: record.code,
      ...(record.step ? { step: record.step } : {}),
      ...(record.exportCleanup ? { exportCleanup: record.exportCleanup } : {}),
      ...custody
    });
  }

  private async audit(
    migrationId: string,
    actor: string,
    action: string,
    detail: Record<string, string | number | boolean>
  ): Promise<void> {
    try {
      await this.migrationRepository.recordEvent(migrationId, { action, actor, detail });
    } catch (error) {
      this.logger.error(`[rehearsal] could not audit ${action}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }
}
