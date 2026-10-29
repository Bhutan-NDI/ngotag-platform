/* eslint-disable camelcase */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AgentRole, OrgAgentMigrationStatus, OrgAgentType } from '@credebl/enum/enum';
import { ResponseMessages } from '@credebl/common/response-messages';
import { org_agent_migrations } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { AgentServiceRepository } from '../repositories/agent-service.repository';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { IAgentAccess, MigrationAgentAccess } from './migration-agent-access';
import { IAgentInfo, IAgentRuntimeConfig, MigrationAgentClient, MigrationAgentError } from './migration-agent.client';
import { IPreflightCheck, IPreflightReport, PreflightCheckId } from './org-agent-migration.interface';

type Check = Omit<IPreflightCheck, 'id'>;

const pass = (detail?: IPreflightCheck['detail']): Check => ({ status: 'PASS', ...(detail ? { detail } : {}) });
const fail = (code: string, detail?: IPreflightCheck['detail']): Check => ({
  status: 'FAIL',
  code,
  ...(detail ? { detail } : {})
});
const skipped = (): Check => ({ status: 'SKIPPED' });

const sameAddress = (a: string, b: string): boolean => {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
};

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((value) => b.includes(value));

/**
 * The agent settings the move depends on (SAD 5.3): the dedicated agent answers like the shared one, takes DIDComm
 * over http only, can send over http and ws, and runs the cron purge. Returns what differs, or nothing.
 */
export const configMismatches = (shared: IAgentRuntimeConfig, dedicated: IAgentRuntimeConfig): string[] => {
  const differences: string[] = [];
  if (shared.autoAcceptConnections !== dedicated.autoAcceptConnections) {
    differences.push('autoAcceptConnections');
  }
  if (shared.autoAcceptCredentials !== dedicated.autoAcceptCredentials) {
    differences.push('autoAcceptCredentials');
  }
  if (shared.autoAcceptProofs !== dedicated.autoAcceptProofs) {
    differences.push('autoAcceptProofs');
  }
  if (!sameSet(dedicated.inboundTransports, ['http'])) {
    differences.push('inboundTransports');
  }
  if (!['http', 'ws'].every((transport) => dedicated.outboundTransports.includes(transport))) {
    differences.push('outboundTransports');
  }
  if (!dedicated.cronPurgeEnabled) {
    differences.push('cronPurgeEnabled');
  }
  return differences;
};

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
    private readonly logger: Logger
  ) {}

  /**
   * Runs every check and stores the report. `apiKey`, when given, is exchanged for a fresh root token; otherwise the
   * token kept from the last run is used.
   * @throws when the migration is past the point where checks apply
   */
  async run(
    migrationId: string,
    input: { apiKey?: string; backupsConfirmed?: boolean },
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
      this.checkArtefacts(migration, record)
    ]);

    const report = this.buildReport(checks);
    const updated = await this.migrationRepository.update(migration.id, {
      preflight: report as never,
      backupsConfirmedAt,
      ...(freshToken && 'PASS' === checks.get(PreflightCheckId.TOKEN_IS_ROOT)?.status
        ? { targetTokenEncrypted: this.access.encryptToken(freshToken) }
        : {}),
      ...(dedicatedInfo
        ? { releaseVersion: dedicatedInfo.releaseVersion, storageVersion: dedicatedInfo.storageVersion }
        : {})
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

    const endpoints = info.endpoints ?? [];
    record(
      PreflightCheckId.ENDPOINT_MATCHES,
      endpoints[0] && sameAddress(endpoints[0], migration.targetDidcommEndpoint)
        ? pass()
        : fail('ENDPOINT_MISMATCH', { reported: endpoints })
    );

    const sharedInfo = await this.readSharedInfo(shared);
    record(PreflightCheckId.RELEASE_MATCHES, this.compareRelease(info, sharedInfo));
    record(PreflightCheckId.CONFIG_MATCHES, this.compareConfig(info, sharedInfo));
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

  private compareRelease(dedicated: IAgentInfo, shared?: IAgentInfo): Check {
    if (!shared) {
      return fail('SHARED_AGENT_UNAVAILABLE');
    }
    if (!dedicated.releaseVersion || dedicated.releaseVersion !== shared.releaseVersion) {
      return fail('RELEASE_MISMATCH', {
        found: dedicated.releaseVersion ?? 'unknown',
        required: shared.releaseVersion ?? 'unknown'
      });
    }
    if (dedicated.storageVersion !== shared.storageVersion) {
      return fail('STORAGE_VERSION_MISMATCH', {
        found: dedicated.storageVersion ?? 'unknown',
        required: shared.storageVersion ?? 'unknown'
      });
    }
    return pass({ release: dedicated.releaseVersion });
  }

  private compareConfig(dedicated: IAgentInfo, shared?: IAgentInfo): Check {
    if (!shared) {
      return fail('SHARED_AGENT_UNAVAILABLE');
    }
    if (!dedicated.config || !shared.config) {
      return fail('CONFIG_UNAVAILABLE');
    }
    const differences = configMismatches(shared.config, dedicated.config);
    return 0 === differences.length ? pass() : fail('CONFIG_MISMATCH', { settings: differences });
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
        // Any HTTP answer counts as reachable to the probe, but a 5xx means no healthy target behind the address, and the
        // relay would forward held messages into it.
        probe.reachable && 500 > (probe.status ?? 0)
          ? pass()
          : fail('DIDCOMM_UNREACHABLE', {
              reason: probe.reason ?? (probe.status ? `HTTP_${probe.status}` : 'UNREACHABLE')
            })
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
      const { schemes, unresolvedDids = 0 } = await this.agentClient.getEndpointSchemes(
        shared.endpoint,
        shared.token,
        migration.tenantId
      );
      const websocket = schemes.filter(({ scheme }) => ['ws', 'wss'].includes(scheme)).map(({ scheme }) => scheme);
      // A DID whose document could not be read has no endpoints in the scan, so the check did not cover it.
      record(
        PreflightCheckId.NO_WEBSOCKET_ENDPOINTS,
        0 === websocket.length
          ? pass(0 < unresolvedDids ? { unresolvedDids } : undefined)
          : fail('RELAY_WS_UNSUPPORTED', { schemes: websocket })
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
