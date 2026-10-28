/* eslint-disable camelcase */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AgentRole, OrgAgentMigrationStatus, OrgAgentType } from '@credebl/enum/enum';
import { ResponseMessages } from '@credebl/common/response-messages';
import { org_agent_migrations } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { AgentServiceRepository } from '../repositories/agent-service.repository';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { IAgentAccess, MigrationAgentAccess } from './migration-agent-access';
import { IAgentInfo, MigrationAgentClient, MigrationAgentError } from './migration-agent.client';
import {
  AgentCheck,
  checkConfig,
  checkEndpoint,
  checkRelease,
  configMismatches,
  fail,
  pass
} from './migration-agent-checks';
import { DownloadMethod, IPreflightReport, IRehearsalRecord, PreflightCheckId } from './org-agent-migration.interface';
import { OrgAgentMigrationWebhookService } from './org-agent-migration.webhook.service';

type Check = AgentCheck;

const skipped = (): Check => ({ status: 'SKIPPED' });

// Kept here too: the specs and callers have always imported it from this module.
export { configMismatches };

/**
 * Checks that an organisation can move: the dedicated agent is the right agent in the right shape, nothing the move
 * cannot carry is in use, and the owner has confirmed their backups. Re-runnable: a failed check never fails the
 * migration, it just stays on the report until it passes.
 */
@Injectable()
export class OrgAgentMigrationPreflightService {
  constructor(
    private readonly agentServiceRepository: AgentServiceRepository,
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly agentClient: MigrationAgentClient,
    private readonly access: MigrationAgentAccess,
    private readonly webhookService: OrgAgentMigrationWebhookService,
    private readonly logger: Logger
  ) {}

  /**
   * Runs every check and stores the report. `apiKey`, when given, is exchanged for a fresh root token; otherwise the
   * token kept from the last run is used.
   * @throws when the migration is past the point where checks apply
   */
  async run(
    migrationId: string,
    // `keepDownloadMethod`: the final check before the freeze, which must not switch to a method nobody rehearsed.
    input: { apiKey?: string; backupsConfirmed?: boolean; keepDownloadMethod?: boolean },
    actor: string | null = null
  ): Promise<{ migration: org_agent_migrations; report: IPreflightReport }> {
    const migration = await this.migrationRepository.getById(migrationId);
    if (!migration) {
      throw new NotFoundException(ResponseMessages.agent.error.migrationNotFound);
    }
    if (![OrgAgentMigrationStatus.CREATED, OrgAgentMigrationStatus.REHEARSED].includes(migration.status as never)) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationInvalidTransition);
    }

    const backupsConfirmedAt = migration.backupsConfirmedAt ?? (input.backupsConfirmed ? new Date() : null);
    const checks = new Map<PreflightCheckId, Check>();
    const record = (id: PreflightCheckId, check: Check): void => {
      checks.set(id, check);
    };

    const orgAgent = await this.agentServiceRepository.getAgentDetailsByOrgId(migration.orgId);
    const sharedTypeId = await this.agentServiceRepository.getOrgAgentTypeDetails(OrgAgentType.SHARED);
    record(
      PreflightCheckId.ORG_IS_SHARED,
      orgAgent && orgAgent.orgAgentTypeId === sharedTypeId ? pass() : fail('ORG_NOT_SHARED')
    );
    record(PreflightCheckId.BACKUPS_CONFIRMED, backupsConfirmedAt ? pass() : fail('BACKUPS_NOT_CONFIRMED'));

    const shared = await this.access.shared();
    const { token, freshToken } = await this.dedicatedToken(migration, input.apiKey, record);
    const dedicatedInfo = token ? await this.checkDedicatedAgent(migration, token, shared, record) : undefined;

    await Promise.all([
      this.checkImportSession(migration, token, dedicatedInfo, record),
      this.checkDidcommReachable(migration, shared, record),
      this.checkSharedRedis(shared, record),
      this.checkEndpointSchemes(migration, shared, record),
      this.checkBulkJobs(migration, record),
      this.checkArtefacts(migration, record),
      this.checkWebhook(migration, token, dedicatedInfo, record)
    ]);

    const downloadMethod = await this.checkDownloadMethod(
      migration,
      token,
      dedicatedInfo,
      record,
      input.keepDownloadMethod
    );

    const report = this.buildReport(checks);
    const updated = await this.migrationRepository.update(migration.id, {
      preflight: report as never,
      backupsConfirmedAt,
      ...(freshToken && 'PASS' === checks.get(PreflightCheckId.TOKEN_IS_ROOT)?.status
        ? { targetTokenEncrypted: this.access.encryptToken(freshToken) }
        : {}),
      ...(dedicatedInfo
        ? { releaseVersion: dedicatedInfo.releaseVersion, storageVersion: dedicatedInfo.storageVersion }
        : {}),
      ...(downloadMethod ? { downloadMethod } : {})
    });
    await this.auditRun(migration.id, actor, report);
    return { migration: updated, report };
  }

  private async auditRun(migrationId: string, actor: string | null, report: IPreflightReport): Promise<void> {
    try {
      await this.migrationRepository.recordEvent(migrationId, {
        action: 'PREFLIGHT_RUN',
        actor,
        detail: {
          passed: report.passed,
          failed: report.checks.filter((check) => 'FAIL' === check.status).map((check) => check.id)
        }
      });
    } catch (error) {
      this.logger.error(`[preflight] could not audit the run: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  private buildReport(checks: Map<PreflightCheckId, Check>): IPreflightReport {
    const ordered = Object.values(PreflightCheckId).map((id) => ({ id, ...(checks.get(id) ?? skipped()) }));
    return {
      ranAt: new Date().toISOString(),
      passed: ordered.every((check) => 'PASS' === check.status),
      checks: ordered
    };
  }

  // Exchanges the API key for a root token, or falls back to the one kept from an earlier run.
  private async dedicatedToken(
    migration: org_agent_migrations,
    apiKey: string | undefined,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<{ token?: string; freshToken?: string }> {
    try {
      if (apiKey) {
        const token = await this.agentClient.createToken(migration.targetAdminEndpoint, apiKey);
        return { token, freshToken: token };
      }
      const stored = await this.access.dedicated(migration);
      if (stored) {
        return { token: stored.token };
      }
      record(PreflightCheckId.AGENT_REACHABLE, fail('API_KEY_REQUIRED'));
    } catch (error) {
      record(PreflightCheckId.AGENT_REACHABLE, fail(this.agentFailureCode(error)));
    }
    return {};
  }

  private agentFailureCode(error: unknown): string {
    if (error instanceof MigrationAgentError) {
      return 'REJECTED' === error.kind ? 'AGENT_TOKEN_REJECTED' : 'AGENT_UNREACHABLE';
    }
    return 'AGENT_UNREACHABLE';
  }

  private async checkDedicatedAgent(
    migration: org_agent_migrations,
    token: string,
    shared: IAgentAccess | undefined,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<IAgentInfo | undefined> {
    let role: string | undefined;
    try {
      role = (jwt.decode(token) as jwt.JwtPayload | null)?.role;
    } catch {
      role = undefined;
    }
    record(
      PreflightCheckId.TOKEN_IS_ROOT,
      AgentRole.RestRootAgent === role ? pass() : fail('TOKEN_NOT_ROOT', { found: role ?? 'none' })
    );

    let info: IAgentInfo;
    try {
      info = await this.agentClient.getAgentInfo(migration.targetAdminEndpoint, token);
      record(PreflightCheckId.AGENT_REACHABLE, info.isInitialized ? pass() : fail('AGENT_NOT_INITIALIZED'));
    } catch (error) {
      record(PreflightCheckId.AGENT_REACHABLE, fail(this.agentFailureCode(error)));
      return undefined;
    }

    record(PreflightCheckId.ENDPOINT_MATCHES, checkEndpoint(info, migration.targetDidcommEndpoint));

    const sharedInfo = await this.readSharedInfo(shared);
    record(PreflightCheckId.RELEASE_MATCHES, checkRelease(info, sharedInfo));
    record(PreflightCheckId.CONFIG_MATCHES, checkConfig(info, sharedInfo));
    return info;
  }

  private async readSharedInfo(shared?: IAgentAccess): Promise<IAgentInfo | undefined> {
    if (!shared) {
      return undefined;
    }
    try {
      return await this.agentClient.getAgentInfo(shared.endpoint, shared.token);
    } catch {
      return undefined;
    }
  }

  // A fresh session proves the wallet is pristine; it expires on its own and is not used again.
  private async checkImportSession(
    migration: org_agent_migrations,
    token: string | undefined,
    info: IAgentInfo | undefined,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<void> {
    if (!token || !info) {
      return;
    }
    try {
      await this.agentClient.createImportSession(migration.targetAdminEndpoint, token);
      record(PreflightCheckId.TARGET_PRISTINE, pass());
    } catch (error) {
      record(
        PreflightCheckId.TARGET_PRISTINE,
        error instanceof MigrationAgentError && 'CONFLICT' === error.kind && 'TARGET_NOT_PRISTINE' === error.agentCode
          ? fail('TARGET_NOT_PRISTINE')
          : fail(this.agentFailureCode(error))
      );
    }
  }

  private async checkWebhook(
    migration: org_agent_migrations,
    token: string | undefined,
    info: IAgentInfo | undefined,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<void> {
    if (!token || !info) {
      return;
    }
    const result = await this.webhookService.check(migration, { endpoint: migration.targetAdminEndpoint, token });
    record(PreflightCheckId.WEBHOOK_DELIVERS, result.confirmed ? pass() : fail(result.code));
  }

  // An agent that cannot reach S3 is not refused, the platform sends it the export instead. With the method locked
  // (the final check) it is the method the rehearsal ran: a PULL that can no longer reach S3 fails, since the move's
  // budget was sized for it, and a PUSH stays PUSH.
  private async checkDownloadMethod(
    migration: org_agent_migrations,
    token: string | undefined,
    info: IAgentInfo | undefined,
    record: (id: PreflightCheckId, check: Check) => void,
    lock = false
  ): Promise<DownloadMethod | undefined> {
    if (!token || !info) {
      return undefined;
    }
    const rehearsed = lock ? ((migration.rehearsal as IRehearsalRecord | null)?.downloadMethod ?? 'PULL') : null;
    try {
      const bucket = await this.agentClient.getExportBucket(migration.targetAdminEndpoint, token);
      const reachable = bucket.configured && bucket.reachable;
      const reason = bucket.configured ? (bucket.reason ?? 'UNREACHABLE') : 'BUCKET_NOT_CONFIGURED';
      if (rehearsed) {
        record(
          PreflightCheckId.DOWNLOAD_METHOD,
          'PULL' === rehearsed && !reachable
            ? fail('DOWNLOAD_METHOD_CHANGED', { rehearsed, reason })
            : pass({ method: rehearsed })
        );
        return rehearsed;
      }
      if (reachable) {
        record(PreflightCheckId.DOWNLOAD_METHOD, pass({ method: 'PULL' }));
        return 'PULL';
      }
      record(PreflightCheckId.DOWNLOAD_METHOD, pass({ method: 'PUSH', reason }));
      return 'PUSH';
    } catch {
      // Not answering is another check's finding; the method stays what it was.
      return undefined;
    }
  }

  private async checkDidcommReachable(
    migration: org_agent_migrations,
    shared: IAgentAccess | undefined,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<void> {
    if (!shared || !migration.tenantId) {
      record(PreflightCheckId.DIDCOMM_REACHABLE, fail('SHARED_AGENT_UNAVAILABLE'));
      return;
    }
    try {
      const probe = await this.agentClient.probeRelayTarget(
        shared.endpoint,
        shared.token,
        migration.tenantId,
        migration.targetDidcommEndpoint
      );
      record(
        PreflightCheckId.DIDCOMM_REACHABLE,
        probe.reachable ? pass() : fail('DIDCOMM_UNREACHABLE', { reason: probe.reason ?? 'UNREACHABLE' })
      );
    } catch {
      record(PreflightCheckId.DIDCOMM_REACHABLE, fail('SHARED_AGENT_UNAVAILABLE'));
    }
  }

  private async checkSharedRedis(
    shared: IAgentAccess | undefined,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<void> {
    if (!shared) {
      record(PreflightCheckId.SHARED_REDIS, fail('SHARED_AGENT_UNAVAILABLE'));
      return;
    }
    try {
      const health = await this.agentClient.getRelayHealth(shared.endpoint, shared.token);
      record(
        PreflightCheckId.SHARED_REDIS,
        health.enabled && health.redisReady ? pass() : fail('RELAY_REQUIRES_SHARED_REDIS')
      );
    } catch (error) {
      // A relay that is switched off answers 409 on every route but health; either way the move cannot run.
      record(
        PreflightCheckId.SHARED_REDIS,
        error instanceof MigrationAgentError && 'CONFLICT' === error.kind
          ? fail('RELAY_REQUIRES_SHARED_REDIS')
          : fail('SHARED_AGENT_UNAVAILABLE')
      );
    }
  }

  private async checkEndpointSchemes(
    migration: org_agent_migrations,
    shared: IAgentAccess | undefined,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<void> {
    if (!shared || !migration.tenantId) {
      record(PreflightCheckId.NO_WEBSOCKET_ENDPOINTS, fail('SHARED_AGENT_UNAVAILABLE'));
      return;
    }
    try {
      const { schemes } = await this.agentClient.getEndpointSchemes(shared.endpoint, shared.token, migration.tenantId);
      const websocket = schemes.filter(({ scheme }) => ['ws', 'wss'].includes(scheme)).map(({ scheme }) => scheme);
      record(
        PreflightCheckId.NO_WEBSOCKET_ENDPOINTS,
        0 === websocket.length ? pass() : fail('RELAY_WS_UNSUPPORTED', { schemes: websocket })
      );
    } catch {
      record(PreflightCheckId.NO_WEBSOCKET_ENDPOINTS, fail('SHARED_AGENT_UNAVAILABLE'));
    }
  }

  private async checkBulkJobs(
    migration: org_agent_migrations,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<void> {
    try {
      const active = await this.migrationRepository.hasActiveBulkIssuance(migration.orgId);
      record(PreflightCheckId.NO_BULK_JOB, active ? fail('ORG_BULK_JOB_ACTIVE') : pass());
    } catch (error) {
      this.logger.error(`[preflight] bulk job check failed: ${error instanceof Error ? error.message : 'failed'}`);
      record(PreflightCheckId.NO_BULK_JOB, fail('CHECK_FAILED'));
    }
  }

  private async checkArtefacts(
    migration: org_agent_migrations,
    record: (id: PreflightCheckId, check: Check) => void
  ): Promise<void> {
    try {
      const counts = await this.migrationRepository.countOutOfScopeArtefacts(migration.orgId);
      const found = Object.entries(counts)
        .filter(([, count]) => 0 < count)
        .map(([kind]) => kind);
      record(
        PreflightCheckId.NO_OUT_OF_SCOPE_ARTEFACTS,
        0 === found.length ? pass() : fail('OUT_OF_SCOPE_ARTEFACTS', { found })
      );
    } catch (error) {
      this.logger.error(`[preflight] artefact check failed: ${error instanceof Error ? error.message : 'failed'}`);
      record(PreflightCheckId.NO_OUT_OF_SCOPE_ARTEFACTS, fail('CHECK_FAILED'));
    }
  }
}
