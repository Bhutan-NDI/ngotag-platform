/* eslint-disable camelcase */
import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';
import { org_agent_migrations } from '@prisma/client';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { envMs } from './migration-job-poller';
import { OrgAgentMigrationExecutor } from './org-agent-migration.executor.service';
import { OrgAgentMigrationPreflightService } from './org-agent-migration.preflight.service';
import { isRehearsalStale } from './org-agent-migration.schedule.service';
import { OrgAgentMigrationService } from './org-agent-migration.service';
import { OrgAgentMigrationSwitchOverService } from './org-agent-migration.switch-over.service';

const MINUTE_MS = 60 * 1000;
const INTERVAL_NAME = 'org-agent-migration-tick';
const DEFAULT_MAX_CONCURRENT = 2;
const BATCH = 10;

/**
 * Drives a move from the clock. Each tick it starts confirmed moves whose slot has arrived, and it looks for moves
 * that nobody is running any more: one frozen past its deadline is undone, one that was switched over but never
 * finished is finished. Without that, a restart in the middle of a move would leave an org frozen. After the move it
 * ends each stabilisation window (purging the shared copy and starting the rotation) and watches each rotation until
 * it has settled.
 *
 * Every replica of agent-service ticks. Starting is made exclusive by the status change that claims the move, and
 * recovery by a short lease on the migration.
 */
@Injectable()
export class OrgAgentMigrationScheduler implements OnModuleInit, OnModuleDestroy {
  // Moves this process is running, so a tick does not start one twice or "recover" one that is alive.
  private readonly active = new Set<string>();
  private ticking = false;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly migrationService: OrgAgentMigrationService,
    private readonly preflightService: OrgAgentMigrationPreflightService,
    private readonly executor: OrgAgentMigrationExecutor,
    private readonly switchOverService: OrgAgentMigrationSwitchOverService,
    private readonly logger: Logger
  ) {}

  onModuleInit(): void {
    if ('false' === process.env.ORG_MIGRATION_SCHEDULER_ENABLED) {
      this.logger.log('[migration-scheduler] disabled by ORG_MIGRATION_SCHEDULER_ENABLED');
      return;
    }
    const handle = setInterval(() => void this.tick(), envMs('ORG_MIGRATION_TICK_MS', MINUTE_MS));
    handle.unref();
    this.registry.addInterval(INTERVAL_NAME, handle);
  }

  onModuleDestroy(): void {
    try {
      this.registry.deleteInterval(INTERVAL_NAME);
    } catch {
      // Never registered (the scheduler was disabled).
    }
  }

  /**
   * One pass. Never throws, and a pass that is still running makes the next one skip. Recovery goes first and is
   * guarded on its own: freeing a frozen org matters more than starting the next move, and must not wait on it.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.guarded('recovery', () => this.recoverStalledMoves());
      await this.guarded('start', () => this.startDueMoves());
      await this.guarded('webhooks', () => this.confirmWebhooks());
      await this.guarded('switch-over', () => this.switchOverEndedWindows());
      await this.guarded('rotation', () => this.driveRotations());
    } finally {
      this.ticking = false;
    }
  }

  private async guarded(phase: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(`[migration-scheduler] ${phase} failed: ${this.describe(error)}`);
    }
  }

  private async startDueMoves(): Promise<void> {
    const limit = envMs('ORG_MIGRATION_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT);
    const room = limit - (await this.migrationRepository.countInFlight());
    if (0 >= room) {
      return;
    }
    for (const migration of await this.migrationRepository.findDueForStart(new Date(), room)) {
      if (this.active.size >= limit) {
        return;
      }
      try {
        await this.begin(migration);
      } catch (error) {
        this.logger.error(`[migration-scheduler] ${migration.id}: could not start: ${this.describe(error)}`);
      }
    }
  }

  // The checks run again just before the freeze, so an org is never frozen for a move that cannot work.
  private async begin(migration: org_agent_migrations): Promise<void> {
    if (this.active.has(migration.id)) {
      return;
    }
    if (
      !(await this.migrationRepository.tryAcquireLease(
        migration.id,
        envMs('ORG_MIGRATION_RETRY_LEASE_MS', 5 * MINUTE_MS)
      ))
    ) {
      return;
    }

    // A move that missed its slot is taken off it before any check, which would otherwise touch the dedicated agent.
    if (this.waited(migration) > this.startWindowMs()) {
      await this.unschedule(migration, 'SLOT_MISSED', { reason: 'SLOT_MISSED' });
      return;
    }
    // The freeze budget comes from the rehearsal, so a move on a rehearsal that has gone stale is not started either.
    // Measured at the slot, as booking does, so a tick delay or a retry inside the window does not turn it stale.
    if (isRehearsalStale(migration, migration.scheduledFor?.getTime())) {
      await this.unschedule(migration, 'REHEARSAL_STALE', { reason: 'REHEARSAL_STALE' });
      return;
    }
    const failedCheck = await this.failedCheck(migration);
    if (failedCheck) {
      await this.deferOrUnschedule(migration, failedCheck);
      return;
    }

    const actor = (await this.migrationRepository.getConfirmingActor(migration.id)) ?? migration.startedBy;
    this.active.add(migration.id);
    void this.executor
      .run(migration.id, actor)
      .catch((error) =>
        this.logger.error(`[migration-scheduler] ${migration.id}: move crashed: ${this.describe(error)}`)
      )
      .finally(() => this.active.delete(migration.id));
  }

  private async failedCheck(migration: org_agent_migrations): Promise<string | undefined> {
    try {
      const { report } = await this.preflightService.run(migration.id, { keepDownloadMethod: true }, null);
      return report.passed
        ? undefined
        : report.checks.find((check) => 'PASS' !== check.status && 'SKIPPED' !== check.status)?.id;
    } catch (error) {
      this.logger.error(`[migration-scheduler] ${migration.id}: final checks did not run: ${this.describe(error)}`);
      return 'CHECKS_UNAVAILABLE';
    }
  }

  // A failed check is retried until the start window closes, then the move is taken off its slot and nothing changes.
  private async deferOrUnschedule(migration: org_agent_migrations, failedCheck: string): Promise<void> {
    if (this.waited(migration) <= this.startWindowMs()) {
      this.logger.warn(`[migration-scheduler] ${migration.id}: final check ${failedCheck} failed; trying again later`);
      return;
    }
    await this.unschedule(migration, `PREFLIGHT_FAILED:${failedCheck}`, {
      reason: 'FINAL_CHECK_FAILED',
      check: failedCheck
    });
  }

  // The slot was chosen to keep citizens undisturbed, so a move that missed it is not started at some other time.
  // Nothing has run, so it goes back to waiting for a new slot instead of ending.
  private async unschedule(
    migration: org_agent_migrations,
    reason: string,
    detail: Record<string, string>
  ): Promise<void> {
    try {
      await this.migrationService.unschedule(migration.id, reason, migration.scheduledFor);
    } catch (error) {
      // The owner moved the slot while the checks ran: their new slot stands.
      if (error instanceof ConflictException) {
        return;
      }
      throw error;
    }
    await this.migrationRepository.recordEvent(migration.id, { action: 'MOVE_UNSCHEDULED', actor: null, detail });
  }

  private waited(migration: org_agent_migrations): number {
    return Date.now() - (migration.scheduledFor?.getTime() ?? Date.now());
  }

  private startWindowMs(): number {
    return envMs('ORG_MIGRATION_START_WINDOW_MS', 30 * MINUTE_MS);
  }

  // While a window is open, keep checking until the new agent's webhooks are seen to arrive. Tries are spaced by their
  // own timestamp, not the lease, so a restore is never refused as busy because of them.
  private async confirmWebhooks(): Promise<void> {
    const now = new Date();
    const retryBefore = new Date(now.getTime() - envMs('ORG_MIGRATION_WEBHOOK_RETRY_MS', 10 * MINUTE_MS));
    for (const migration of await this.migrationRepository.findAwaitingWebhook(now, retryBefore, BATCH)) {
      try {
        if (!(await this.migrationRepository.tryBeginWebhookCheck(migration.id, now, retryBefore))) {
          continue;
        }
        await this.switchOverService.checkWebhook(migration.id);
      } catch (error) {
        this.logger.error(`[migration-scheduler] ${migration.id}: webhook check failed: ${this.describe(error)}`);
      }
    }
  }

  // The window has ended: switch the org over for good, if it is safe, and carry straight on into the rotation.
  private async switchOverEndedWindows(): Promise<void> {
    for (const migration of await this.migrationRepository.findWindowEnded(new Date(), BATCH)) {
      try {
        if (
          !(await this.migrationRepository.tryAcquireLease(
            migration.id,
            envMs('ORG_MIGRATION_SWITCHOVER_RETRY_MS', 2 * MINUTE_MS)
          ))
        ) {
          continue;
        }
        if ('STARTED' === (await this.switchOverService.beginSwitchOver(migration.id))) {
          await this.switchOverService.advanceRotation(migration.id);
        }
      } catch (error) {
        this.logger.error(`[migration-scheduler] ${migration.id}: switch-over failed: ${this.describe(error)}`);
      }
    }
  }

  // Purge and start quickly while there is something to do; once the rotation is running, only look in now and then.
  private async driveRotations(): Promise<void> {
    for (const migration of await this.migrationRepository.findRotating(new Date(), BATCH)) {
      try {
        const watching = Boolean(migration.purgedAt && migration.rotationJobId);
        const leaseMs = watching
          ? envMs('ORG_MIGRATION_ROTATION_POLL_MS', 10 * MINUTE_MS)
          : envMs('ORG_MIGRATION_SWITCHOVER_RETRY_MS', 2 * MINUTE_MS);
        if (!(await this.migrationRepository.tryAcquireLease(migration.id, leaseMs))) {
          continue;
        }
        await this.switchOverService.advanceRotation(migration.id);
      } catch (error) {
        this.logger.error(`[migration-scheduler] ${migration.id}: rotation step failed: ${this.describe(error)}`);
      }
    }
  }

  private async recoverStalledMoves(): Promise<void> {
    const stalled = await this.migrationRepository.findStalled(
      new Date(),
      envMs('ORG_MIGRATION_STALL_GRACE_MS', 5 * MINUTE_MS)
    );
    for (const migration of stalled) {
      if (this.active.has(migration.id)) {
        continue;
      }
      try {
        if (
          !(await this.migrationRepository.tryAcquireLease(
            migration.id,
            envMs('ORG_MIGRATION_RECOVERY_LEASE_MS', 2 * MINUTE_MS)
          ))
        ) {
          continue;
        }
        this.logger.warn(`[migration-scheduler] ${migration.id}: recovering a stalled move in ${migration.status}`);
        if (OrgAgentMigrationStatus.CUTOVER === migration.status) {
          await this.executor.resumeCutover(migration.id);
        } else {
          await this.executor.abortInterrupted(migration.id);
        }
      } catch (error) {
        this.logger.error(`[migration-scheduler] ${migration.id}: recovery failed: ${this.describe(error)}`);
      }
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'failed';
  }
}
