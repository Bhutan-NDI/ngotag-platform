/* eslint-disable camelcase */
import { Injectable, Logger } from '@nestjs/common';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';
import { org_agent_migrations } from '@prisma/client';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { IAgentAccess, MigrationAgentAccess } from './migration-agent-access';
import { IRotationStatus, MigrationAgentClient, MigrationAgentError } from './migration-agent.client';
import { IRotationProgress } from './org-agent-migration.interface';
import { OrgAgentMigrationService } from './org-agent-migration.service';

export type SwitchOverOutcome = 'STARTED' | 'DEFERRED' | 'SKIPPED';

/**
 * Whether every connection has had its change of address sent and has answered, been refused or gone stale. The
 * agent's own job finishes once everything is *sent*, which is earlier than that; a connection that failed for good
 * is counted in the progress but does not hold the move open, because it keeps working through forwarding.
 */
export const rotationSettled = (status: IRotationStatus): boolean =>
  'completed' === status.job.status &&
  0 === status.counts.pending &&
  0 === status.counts.retrying &&
  0 === status.counts.waiting;

const toProgress = (status: IRotationStatus): IRotationProgress => ({
  job: { ...status.job },
  counts: { ...status.counts },
  polledAt: new Date().toISOString()
});

/**
 * What happens when the stabilisation window ends (SAD E.5, ADR-WM-006): the shared agent's copy of the wallet is
 * purged, which is the point of no return, and then every connection is moved to the new address. It only ever
 * purges once it is safe to: the window has ended, held messages are going to the new agent, and the new agent is up.
 * Otherwise it waits and says why on the migration.
 */
@Injectable()
export class OrgAgentMigrationSwitchOverService {
  constructor(
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly migrationService: OrgAgentMigrationService,
    private readonly access: MigrationAgentAccess,
    private readonly agentClient: MigrationAgentClient,
    private readonly logger: Logger
  ) {}

  /**
   * Ends the stabilisation window: STABILISING -> ROTATING, if it is safe. The status change comes first and is the
   * point of no return, so a disaster restore can no longer race the purge that follows.
   * @returns SKIPPED when the migration is not in an ended window, DEFERRED when something is not ready yet
   */
  async beginSwitchOver(migrationId: string): Promise<SwitchOverOutcome> {
    const migration = await this.migrationRepository.getById(migrationId);
    if (
      !migration ||
      OrgAgentMigrationStatus.STABILISING !== migration.status ||
      !migration.stabilisationEndsAt ||
      migration.stabilisationEndsAt.getTime() > Date.now()
    ) {
      return 'SKIPPED';
    }

    const blocker = await this.blocker(migration);
    if (blocker) {
      await this.noteIssue(migration, `SWITCHOVER_DEFERRED:${blocker}`);
      return 'DEFERRED';
    }

    try {
      await this.migrationService.advance(migrationId, OrgAgentMigrationStatus.ROTATING, null, { error: null });
    } catch (error) {
      this.logger.warn(`[switch-over] ${migrationId}: not started, ${this.describe(error)}`);
      return 'SKIPPED';
    }
    await this.audit(migrationId, 'SWITCHOVER_STARTED', {});
    return 'STARTED';
  }

  /**
   * One step forward for a migration that is rotating: purge the shared copy, start the rotation, then watch it until
   * it has settled. Repeated calls are safe; each only does what has not been done yet.
   */
  async advanceRotation(migrationId: string): Promise<void> {
    let migration = await this.migrationRepository.getById(migrationId);
    if (!migration || OrgAgentMigrationStatus.ROTATING !== migration.status) {
      return;
    }

    const shared = await this.access.shared();
    const dedicated = await this.dedicatedOf(migration);
    if (!shared || !migration.tenantId) {
      await this.noteIssue(migration, 'SHARED_AGENT_UNAVAILABLE');
      return;
    }
    if (!dedicated) {
      await this.noteIssue(migration, 'DEDICATED_AGENT_UNAVAILABLE');
      return;
    }

    if (!migration.purgedAt) {
      migration = await this.purge(migration, shared);
      if (!migration.purgedAt) {
        return;
      }
    }
    if (!migration.rotationJobId) {
      migration = await this.startRotation(migration, dedicated);
      if (!migration.rotationJobId) {
        return;
      }
    }
    await this.watchRotation(migration, dedicated);
  }

  // Every condition that must hold before the shared copy is deleted. Returns the first that does not, or nothing.
  private async blocker(migration: org_agent_migrations): Promise<string | undefined> {
    const shared = await this.access.shared();
    if (!shared || !migration.tenantId) {
      return 'SHARED_AGENT_UNAVAILABLE';
    }
    const dedicated = await this.dedicatedOf(migration);
    if (!dedicated) {
      return 'DEDICATED_AGENT_UNAVAILABLE';
    }

    try {
      const relay = await this.agentClient.getRelay(shared.endpoint, shared.token, migration.tenantId);
      if ('FORWARD' !== relay.mode || !relay.target) {
        return 'RELAY_NOT_FORWARDING';
      }
    } catch (error) {
      return error instanceof MigrationAgentError && 'NOT_FOUND' === error.kind
        ? 'RELAY_NOT_FORWARDING'
        : 'SHARED_AGENT_UNAVAILABLE';
    }

    try {
      const info = await this.agentClient.getAgentInfo(dedicated.endpoint, dedicated.token);
      return info.isInitialized ? undefined : 'DEDICATED_AGENT_NOT_READY';
    } catch {
      return 'DEDICATED_AGENT_UNREACHABLE';
    }
  }

  private async dedicatedOf(migration: org_agent_migrations): Promise<IAgentAccess | undefined> {
    try {
      return await this.access.dedicatedOfOrg(migration.orgId);
    } catch {
      return undefined;
    }
  }

  private async purge(migration: org_agent_migrations, shared: IAgentAccess): Promise<org_agent_migrations> {
    try {
      const { profileRemoved } = await this.agentClient.purgeProfile(shared.endpoint, shared.token, migration.tenantId);
      const purged = await this.migrationRepository.update(migration.id, { purgedAt: new Date(), error: null });
      await this.audit(migration.id, 'PROFILE_PURGED', { profileRemoved });
      return purged;
    } catch (error) {
      // The agent refuses a purge while the relay is not forwarding; that is a different problem from it being down.
      const refused = error instanceof MigrationAgentError && 'CONFLICT' === error.kind;
      await this.noteIssue(migration, refused ? 'PURGE_REFUSED' : 'PURGE_FAILED');
      return migration;
    }
  }

  private async startRotation(migration: org_agent_migrations, dedicated: IAgentAccess): Promise<org_agent_migrations> {
    try {
      const status = await this.agentClient.startRotation(dedicated.endpoint, dedicated.token);
      const started = await this.migrationRepository.update(migration.id, {
        // The agent keeps one rotation job; when it started names it.
        rotationJobId: `rotate-all:${status.job.startedAt ?? new Date().toISOString()}`,
        rotation: toProgress(status) as never,
        error: null
      });
      await this.audit(migration.id, 'ROTATION_STARTED', { connections: status.counts.total });
      return started;
    } catch (error) {
      await this.noteIssue(migration, 'ROTATION_START_FAILED');
      return migration;
    }
  }

  private async watchRotation(migration: org_agent_migrations, dedicated: IAgentAccess): Promise<void> {
    let status: IRotationStatus;
    try {
      status = await this.agentClient.getRotationStatus(dedicated.endpoint, dedicated.token);
    } catch {
      await this.noteIssue(migration, 'ROTATION_STATUS_UNAVAILABLE');
      return;
    }

    // The agent lost its job (a restart that dropped it): start it again rather than wait for nothing. A finished job
    // is not restarted for holders who connected after it: they connected on the new agent and need no rotation.
    if ('idle' === status.job.status) {
      try {
        status = await this.agentClient.startRotation(dedicated.endpoint, dedicated.token);
      } catch {
        await this.noteIssue(migration, 'ROTATION_START_FAILED');
        return;
      }
    }

    const progress = toProgress(status);
    if (!rotationSettled(status)) {
      await this.migrationRepository.update(migration.id, { rotation: progress as never, error: null });
      return;
    }

    try {
      await this.migrationService.advance(migration.id, OrgAgentMigrationStatus.COMPLETED, null, {
        rotation: progress as never,
        error: null
      });
    } catch (error) {
      this.logger.warn(`[switch-over] ${migration.id}: not completed, ${this.describe(error)}`);
      return;
    }
    await this.audit(migration.id, 'MOVE_COMPLETED', { ...status.counts });
  }

  // Said once per change, not once per tick, so a long outage does not flood the audit trail.
  private async noteIssue(migration: org_agent_migrations, code: string): Promise<void> {
    if (migration.error === code) {
      return;
    }
    try {
      await this.migrationRepository.update(migration.id, { error: code });
      await this.audit(migration.id, 'SWITCHOVER_WAITING', { reason: code });
    } catch (error) {
      this.logger.error(`[switch-over] ${migration.id}: could not note ${code}: ${this.describe(error)}`);
    }
  }

  private async audit(
    migrationId: string,
    action: string,
    detail: Record<string, string | number | boolean>
  ): Promise<void> {
    try {
      await this.migrationRepository.recordEvent(migrationId, { action, actor: null, detail });
    } catch (error) {
      this.logger.error(`[switch-over] could not audit ${action}: ${this.describe(error)}`);
    }
  }

  // Only the message: an error from an agent call must never be logged whole.
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'failed';
  }
}
