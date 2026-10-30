/* eslint-disable camelcase */
import { Injectable, Logger } from '@nestjs/common';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';
import { org_agent_migrations } from '@prisma/client';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { IAgentAccess, MigrationAgentAccess } from './migration-agent-access';
import { envMs } from './migration-job-poller';
import { IRotationStatus, MigrationAgentClient, MigrationAgentError } from './migration-agent.client';
import { MigrationNoticeKind, OrgAgentMigrationAlertService } from './org-agent-migration.alert.service';
import { IRotationProgress } from './org-agent-migration.interface';
import { OrgAgentMigrationService } from './org-agent-migration.service';
import { OrgAgentMigrationWebhookService } from './org-agent-migration.webhook.service';

const MINUTE_MS = 60 * 1000;

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
    private readonly alertService: OrgAgentMigrationAlertService,
    private readonly webhookService: OrgAgentMigrationWebhookService,
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

    // A webhook that stays broken holds the switch-over for a limited time only (ADR-WM-011): the shared copy and the
    // org's keys in two places must not last for ever. Nothing else is capped, since purging with no working wallet on
    // the new agent would leave the org with none.
    const blocker = await this.blocker(migration);
    let unconfirmed: string | undefined;
    if (blocker) {
      if (!blocker.startsWith('WEBHOOK_') || !this.webhookCapReached(migration)) {
        await this.noteIssue(migration, `SWITCHOVER_DEFERRED:${blocker}`);
        // A busy check only means another probe is in flight, which says nothing about the webhook.
        if (blocker.startsWith('WEBHOOK_') && 'WEBHOOK_CHECK_BUSY' !== blocker) {
          await this.tellOnce(migration, 'WEBHOOK_DEFER_ALERTED', MigrationNoticeKind.WEBHOOK_DEFERRED);
        }
        return 'DEFERRED';
      }
      unconfirmed = blocker;
    }

    try {
      await this.migrationService.advance(migrationId, OrgAgentMigrationStatus.ROTATING, null, {
        error: unconfirmed ?? null
      });
    } catch (error) {
      this.logger.warn(`[switch-over] ${migrationId}: not started, ${this.describe(error)}`);
      return 'SKIPPED';
    }
    await this.audit(migrationId, 'SWITCHOVER_STARTED', {});
    if (unconfirmed) {
      await this.audit(migrationId, 'SWITCHOVER_WEBHOOK_UNCONFIRMED', { reason: unconfirmed });
      await this.tellOnce(migration, 'WEBHOOK_PROCEEDED_ALERTED', MigrationNoticeKind.WEBHOOK_GOING_AHEAD);
    }
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

  private webhookCapReached(migration: org_agent_migrations): boolean {
    const cap = envMs('ORG_MIGRATION_WEBHOOK_DEFER_CAP_MS', 24 * 60 * MINUTE_MS);
    return Date.now() >= (migration.stabilisationEndsAt?.getTime() ?? Date.now()) + cap;
  }

  // The people who would notice are told about each of these once, not on every retry.
  private async tellOnce(migration: org_agent_migrations, action: string, kind: MigrationNoticeKind): Promise<void> {
    try {
      if (0 < (await this.migrationRepository.countEvents(migration.id, action))) {
        return;
      }
      await this.alertService.notify(migration, kind);
      await this.audit(migration.id, action, {});
    } catch (error) {
      this.logger.error(`[switch-over] ${migration.id}: could not send ${action}: ${this.describe(error)}`);
    }
  }

  // A webhook problem the switch-over went ahead with stays on the migration, whatever else is cleared as it goes on.
  // Another issue noted meanwhile (a failed purge, a status poll) replaces it on the row, so it is read back from the audit
  // entry written when the switch-over went ahead.
  private async keptError(migration: org_agent_migrations): Promise<string | null> {
    if (migration.error?.startsWith('WEBHOOK_')) {
      return migration.error;
    }
    const reason = (await this.migrationRepository.getEventDetail(migration.id, 'SWITCHOVER_WEBHOOK_UNCONFIRMED'))
      ?.reason;
    return 'string' === typeof reason ? reason : null;
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
      if (!info.isInitialized) {
        return 'DEDICATED_AGENT_NOT_READY';
      }
    } catch {
      return 'DEDICATED_AGENT_UNREACHABLE';
    }

    // The window's other purpose: the shared copy is not deleted while the new agent's webhooks cannot reach us. A move
    // whose preflight predates the check has an agent that may not answer the probe, and is not held to it.
    if (!this.preflightIncludedWebhookCheck(migration)) {
      return undefined;
    }
    const webhook = await this.webhookService.check(migration, dedicated);
    return webhook.confirmed ? undefined : webhook.code;
  }

  /**
   * During an open window, checks that the dedicated agent's webhooks reach the platform, so the owner sees a problem
   * within minutes rather than when the window ends. Says so on the migration, and clears that once it passes.
   */
  async checkWebhook(migrationId: string): Promise<void> {
    const migration = await this.migrationRepository.getById(migrationId);
    if (!migration || OrgAgentMigrationStatus.STABILISING !== migration.status || migration.webhookConfirmedAt) {
      return;
    }
    // A move preflighted before the webhook check existed is not held to it at the end of the window, so it is not told
    // it has a webhook problem during it either.
    if (!this.preflightIncludedWebhookCheck(migration)) {
      return;
    }
    const dedicated = await this.dedicatedOf(migration);
    if (!dedicated) {
      return;
    }

    const result = await this.webhookService.check(migration, dedicated);
    // Only while the window is still open: a disaster restore may have finished the migration during the probe.
    const stabilising = OrgAgentMigrationStatus.STABILISING;
    if (result.confirmed) {
      const cleared = migration.error?.startsWith('WEBHOOK_') ? { error: null } : {};
      if (await this.migrationRepository.updateIfStatus(migration.id, stabilising, cleared)) {
        await this.audit(migration.id, 'WEBHOOK_CONFIRMED', {});
      }
    } else if (result.code.startsWith('WEBHOOK_') && migration.error !== result.code) {
      if (await this.migrationRepository.updateIfStatus(migration.id, stabilising, { error: result.code })) {
        await this.audit(migration.id, 'WEBHOOK_UNCONFIRMED', { reason: result.code });
      }
    }
  }

  private preflightIncludedWebhookCheck(migration: org_agent_migrations): boolean {
    const checks = (migration.preflight as unknown as { checks?: { id?: string }[] } | null)?.checks;
    return Boolean(checks?.some((check) => 'WEBHOOK_DELIVERS' === check.id));
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
      const purged = await this.migrationRepository.update(migration.id, {
        purgedAt: new Date(),
        error: await this.keptError(migration)
      });
      await this.audit(migration.id, 'PROFILE_PURGED', { profileRemoved });
      return purged;
    } catch (error) {
      // The agent refuses a purge while the relay is not forwarding; that is a different problem from it being down. Its
      // own reason is kept, except for the open-sessions message, which names the tenant.
      const refused = error instanceof MigrationAgentError && 'CONFLICT' === error.kind;
      const reason = refused ? (error as MigrationAgentError).agentCode : undefined;
      const code = !refused
        ? 'PURGE_FAILED'
        : ['RELAY_NOT_FORWARDING', 'RELAY_DISABLED'].includes(reason ?? '')
          ? `PURGE_REFUSED:${reason}`
          : 'PURGE_REFUSED';
      await this.noteIssue(migration, code);
      await this.backOffPurge(migration, code);
      return migration;
    }
  }

  // A purge that keeps failing is retried more and more slowly (each failure leaves a session slot behind on the shared
  // agent when its profile removal throws), and the people who would notice are told once.
  private async backOffPurge(migration: org_agent_migrations, code: string): Promise<void> {
    try {
      const attempt = (await this.migrationRepository.countEvents(migration.id, 'PURGE_ATTEMPT_FAILED')) + 1;
      await this.audit(migration.id, 'PURGE_ATTEMPT_FAILED', { attempt, reason: code });
      const base = envMs('ORG_MIGRATION_SWITCHOVER_RETRY_MS', 2 * MINUTE_MS);
      const growth = 2 ** Math.min(attempt - 1, 20);
      const delay = Math.min(base * growth, envMs('ORG_MIGRATION_PURGE_BACKOFF_MAX_MS', 60 * MINUTE_MS));
      await this.migrationRepository.holdLease(migration.id, delay);
      if (attempt === envMs('ORG_MIGRATION_PURGE_ALERT_AFTER', 5)) {
        await this.alertService.notify(migration, MigrationNoticeKind.PURGE_FAILING);
        await this.audit(migration.id, 'PURGE_FAILING_ALERTED', { attempts: attempt });
      }
    } catch (error) {
      this.logger.error(`[switch-over] ${migration.id}: could not back off the purge: ${this.describe(error)}`);
    }
  }

  private async startRotation(migration: org_agent_migrations, dedicated: IAgentAccess): Promise<org_agent_migrations> {
    try {
      const status = await this.agentClient.startRotation(dedicated.endpoint, dedicated.token);
      const started = await this.migrationRepository.update(migration.id, {
        // The agent keeps one rotation job; when it started names it.
        rotationJobId: `rotate-all:${status.job.startedAt ?? new Date().toISOString()}`,
        rotation: toProgress(status) as never,
        error: await this.keptError(migration)
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

    // The agent lost its job, or a finished one left connections that still need rotating (the agent counts holders who
    // connected after its cutoff as updated, so they do not restart it).
    if (
      'idle' === status.job.status ||
      ('completed' === status.job.status && (0 < status.counts.pending || 0 < status.counts.retrying))
    ) {
      try {
        status = await this.agentClient.startRotation(dedicated.endpoint, dedicated.token);
      } catch {
        await this.noteIssue(migration, 'ROTATION_START_FAILED');
        return;
      }
    }

    const progress = toProgress(status);
    // Connections waiting for an answer that does not come for days (a rotation cut off by a redeploy, a holder that never
    // opens its wallet) hold the move in ROTATING, so it is flagged once the number has not moved for a while.
    const previous = migration.rotation as unknown as IRotationProgress | null;
    const waiting = status.counts.waiting ?? 0;
    if (previous && 0 < waiting && (previous.counts?.waiting ?? 0) === waiting) {
      progress.stalledSince = previous.stalledSince ?? previous.polledAt;
    }
    const stalled =
      undefined !== progress.stalledSince &&
      Date.now() - new Date(progress.stalledSince).getTime() >
        envMs('ORG_MIGRATION_ROTATION_STALL_MS', 3 * 24 * 60 * MINUTE_MS);
    if (!rotationSettled(status)) {
      await this.migrationRepository.update(migration.id, {
        rotation: progress as never,
        error: stalled ? 'ROTATION_STALLED' : await this.keptError(migration)
      });
      if (stalled && 'ROTATION_STALLED' !== migration.error) {
        await this.audit(migration.id, 'ROTATION_STALLED', { waiting });
      }
      return;
    }

    try {
      await this.migrationService.advance(migration.id, OrgAgentMigrationStatus.COMPLETED, null, {
        rotation: progress as never,
        error: await this.keptError(migration)
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
