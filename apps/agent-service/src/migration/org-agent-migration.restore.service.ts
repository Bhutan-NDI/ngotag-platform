/* eslint-disable camelcase */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { OrgAgentMigrationStatus, OrgAgentType } from '@credebl/enum/enum';
import { ResponseMessages } from '@credebl/common/response-messages';
import { org_agent_migrations } from '@prisma/client';
import { AgentServiceRepository } from '../repositories/agent-service.repository';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { MigrationAgentAccess } from './migration-agent-access';
import { MigrationAgentClient, MigrationAgentError } from './migration-agent.client';
import { KeyExportAlertKind, OrgAgentMigrationAlertService } from './org-agent-migration.alert.service';

const MINUTE_MS = 60 * 1000;
const LEASE_MS = 5 * MINUTE_MS;

interface ISourceSnapshot {
  agentEndPoint?: string;
  tenantId?: string;
  walletName?: string;
}

/**
 * Disaster restore (SAD E.7, ADR-WM-006): the new agent is lost for good, so the organisation goes back to the shared
 * agent and the wallet it kept. It only exists for the stabilisation window; after that the shared copy is purged and
 * there is nothing to go back to. It is lossy by design: what the new agent recorded since the switch is gone, and
 * the connections made since then break, because their keys only ever existed there.
 */
@Injectable()
export class OrgAgentMigrationRestoreService {
  constructor(
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly agentServiceRepository: AgentServiceRepository,
    private readonly access: MigrationAgentAccess,
    private readonly agentClient: MigrationAgentClient,
    private readonly alertService: OrgAgentMigrationAlertService,
    private readonly logger: Logger
  ) {}

  /**
   * Safe to call again if it stopped half way: taking the relay off a second time is a no-op, and the org row is
   * only switched back once.
   * @param adminUserId the platform admin doing it; named in the audit trail and the alert
   * @throws when there is no move in its stabilisation window, or something else is working on it
   */
  async restore(orgId: string, adminUserId: string): Promise<org_agent_migrations> {
    const migration = await this.migrationRepository.getActiveByOrgId(orgId);
    if (!migration) {
      throw new NotFoundException(ResponseMessages.agent.error.migrationNotFound);
    }
    if (OrgAgentMigrationStatus.STABILISING !== migration.status || migration.purgedAt) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationRestoreNotAllowed);
    }

    const snapshot = (migration.sourceOrgAgentSnapshot ?? {}) as ISourceSnapshot;
    if (!migration.tenantId || !snapshot.agentEndPoint || !snapshot.tenantId) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationRestoreSnapshotMissing);
    }

    // The scheduler skips a migration while it is leased, so the window cannot end underneath the restore.
    if (!(await this.migrationRepository.tryAcquireLease(migration.id, LEASE_MS))) {
      throw new ConflictException(ResponseMessages.agent.error.migrationRestoreBusy);
    }

    try {
      const relay = await this.takeRelayOff(migration);
      const { restored, invitationsRemoved } = await this.switchBack(migration, snapshot, adminUserId);

      await this.audit(migration.id, adminUserId, 'DISASTER_RESTORED', {
        relayWasAlreadyOff: undefined === relay,
        messagesReturned: relay?.injected ?? 0,
        messagesLost: relay?.failed ?? 0,
        invitationsRemoved
      });
      await this.tellPeople(restored, adminUserId);
      return restored;
    } catch (error) {
      // Nothing is running any more, so an immediate retry must not be refused as busy.
      await this.migrationRepository.releaseLease(migration.id).catch(() => undefined);
      throw error;
    }
  }

  // First, so messages reach the shared wallet again before the org starts calling it. Queued ones go back first.
  private async takeRelayOff(
    migration: org_agent_migrations
  ): Promise<{ injected: number; failed: number } | undefined> {
    const shared = await this.access.shared();
    if (!shared) {
      throw new ServiceUnavailableException(ResponseMessages.agent.error.agentDown);
    }
    try {
      return await this.agentClient.restoreRelay(shared.endpoint, shared.token, migration.tenantId);
    } catch (error) {
      if (error instanceof MigrationAgentError) {
        // No relay left: an earlier attempt already took it off.
        if ('NOT_FOUND' === error.kind) {
          return undefined;
        }
        // The shared copy is gone, so there is nothing to give the org back to.
        if ('CONFLICT' === error.kind && 'TENANT_PURGED' === error.agentCode) {
          throw new BadRequestException(ResponseMessages.agent.error.migrationRestoreNotAllowed);
        }
        // An earlier call is still handing the queued messages back; a second drain would lose some of them.
        if ('CONFLICT' === error.kind && 'RELAY_BUSY' === error.agentCode) {
          throw new ConflictException(ResponseMessages.agent.error.migrationRestoreBusy);
        }
      }
      this.logger.error(`[restore] ${migration.id}: could not take the relay off: ${this.describe(error)}`);
      throw new ServiceUnavailableException(ResponseMessages.agent.error.agentDown);
    }
  }

  private async switchBack(
    migration: org_agent_migrations,
    snapshot: ISourceSnapshot,
    adminUserId: string
  ): Promise<{ restored: org_agent_migrations; invitationsRemoved: number }> {
    const [sharedTypeId, dedicatedTypeId] = await Promise.all([
      this.agentServiceRepository.getOrgAgentTypeDetails(OrgAgentType.SHARED),
      this.agentServiceRepository.getOrgAgentTypeDetails(OrgAgentType.DEDICATED)
    ]);

    const { migration: restored, invitationsRemoved } = await this.migrationRepository.restoreOrgAgent({
      migrationId: migration.id,
      orgId: migration.orgId,
      expectedAgentEndPoint: migration.targetAdminEndpoint,
      sharedOrgAgentTypeId: sharedTypeId,
      dedicatedOrgAgentTypeId: dedicatedTypeId,
      agentEndPoint: snapshot.agentEndPoint,
      tenantId: snapshot.tenantId,
      walletName: snapshot.walletName,
      lastChangedBy: adminUserId,
      actor: adminUserId,
      newInvitationDid: migration.newInvitationDid
    });
    return { restored, invitationsRemoved };
  }

  // Best effort: the restore has happened either way, and the audit trail already names who did it.
  private async tellPeople(migration: org_agent_migrations, adminUserId: string): Promise<void> {
    try {
      await this.alertService.alertKeyExport(migration, KeyExportAlertKind.DISASTER_RESTORE, adminUserId);
    } catch (error) {
      this.logger.error(`[restore] ${migration.id}: alert failed: ${this.describe(error)}`);
    }
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
      this.logger.error(`[restore] could not audit ${action}: ${this.describe(error)}`);
    }
  }

  // Only the message: an error from an agent call must never be logged whole.
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'failed';
  }
}
