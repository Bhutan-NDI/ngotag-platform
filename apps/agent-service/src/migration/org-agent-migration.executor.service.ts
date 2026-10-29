/* eslint-disable camelcase */
import { Injectable, Logger } from '@nestjs/common';
import { DidMethod, OrgAgentMigrationStatus, OrgAgentType, ProofType } from '@credebl/enum/enum';
import { org_agent_migrations } from '@prisma/client';
import { createHash } from 'crypto';
import { ConnectionRepository } from '../../../connection/src/connection.repository';
import { ConnectionService } from '../../../connection/src/connection.service';
import { AgentServiceRepository } from '../repositories/agent-service.repository';
import { OrgAgentMigrationRepository, REHEARSAL_DONE } from '../repositories/org-agent-migration.repository';
import { IAgentAccess, MigrationAgentAccess } from './migration-agent-access';
import { checkConfig, checkEndpoint, checkRelease } from './migration-agent-checks';
import { IPortabilityJob, MigrationAgentClient, MigrationAgentError } from './migration-agent.client';
import { envMs, JobPollFailure, jobTimeoutMs, pollJob, sleep } from './migration-job-poller';
import { KeyExportAlertKind, OrgAgentMigrationAlertService } from './org-agent-migration.alert.service';
import { OrgAgentMigrationService } from './org-agent-migration.service';
import { isAbortable } from './org-agent-migration.state-machine';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_FREEZE_MS = 15 * MINUTE_MS;
const DEFAULT_STABILISATION_HOURS = 48;
const COMPLETION_ATTEMPTS = 3;
const RELAY_CLEAR_ATTEMPTS = 3;

interface IMoveCounts {
  entries: number;
  keys: number;
  skipped?: number;
}

// A stable code the studio maps to a message, never raw error text. Verification codes carry the failed check.
class MoveFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface ICompletionStep {
  name: string;
  run: () => Promise<void>;
  required: boolean;
}

interface IMoveContext {
  migration: org_agent_migrations;
  actor: string;
  deadlineAt: number;
  shared?: IAgentAccess;
  dedicated?: IAgentAccess;
  relayHeld: boolean;
  exportJobId?: string;
  // Handed from the export step to the import step.
  sessionId?: string;
  exported?: IPortabilityJob;
  cutOver: boolean;
}

const stabilisationMs = (): number => {
  const hours = Number(process.env.ORG_MIGRATION_STABILISATION_HOURS);
  return (
    (Number.isFinite(hours) && 0 <= hours && '' !== process.env.ORG_MIGRATION_STABILISATION_HOURS
      ? hours
      : DEFAULT_STABILISATION_HOURS) * HOUR_MS
  );
};

// The signature suite follows the key behind the DID, as platform issuance picks it.
const signingProofType = (orgDid: string): ProofType =>
  orgDid.includes(DidMethod.POLYGON) ? ProofType.POLYGON_PROOFTYPE : ProofType.NO_LEDGER_PROOFTYPE;

/**
 * Whether the move brought over what the rehearsal did. Records can fall between the rehearsal and the move (the cron
 * purge removes old ones), so a small drop in entries is tolerated. Keys are the org's identity and are never purged,
 * so none may be missing. With no rehearsal to compare with there is nothing to vouch for the move.
 */
export const countsMatchRehearsal = (
  rehearsal: IMoveCounts | null | undefined,
  moved: IMoveCounts | null | undefined,
  tolerance: number
): boolean => {
  if (!moved || !rehearsal || !Number.isFinite(moved.entries) || !Number.isFinite(moved.keys)) {
    return false;
  }
  return moved.entries >= Math.floor(rehearsal.entries * (1 - tolerance)) && moved.keys >= rehearsal.keys;
};

/**
 * Move day (SAD E.3): freeze the org, hold its inbound messages, export its wallet sealed to the new agent, import it
 * there, check it, and switch the org over. Everything before the switch can be undone without loss: any failure, or
 * running past the freeze budget, puts the held messages back and leaves the org exactly as it was. From the switch
 * on there is no undoing, so the rest of the move only ever finishes (`finishCutover`), and can be resumed.
 *
 * The orchestrator never goes through getOrgAgentApiKey, so the freeze does not lock it out: it calls the shared
 * agent with the base-wallet token and the dedicated agent with the token stored at preflight.
 */
@Injectable()
export class OrgAgentMigrationExecutor {
  constructor(
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly migrationService: OrgAgentMigrationService,
    private readonly agentServiceRepository: AgentServiceRepository,
    private readonly access: MigrationAgentAccess,
    private readonly agentClient: MigrationAgentClient,
    private readonly alertService: OrgAgentMigrationAlertService,
    private readonly connectionRepository: ConnectionRepository,
    private readonly connectionService: ConnectionService,
    private readonly logger: Logger
  ) {}

  /**
   * Runs the whole move for a rehearsed migration. Never throws: a failure aborts the move and is recorded on it.
   * @param actorUserId the owner who confirmed the move; named in the export alert
   */
  async run(migrationId: string, actorUserId: string): Promise<void> {
    const claimed = await this.claim(migrationId, actorUserId);
    if (!claimed) {
      return;
    }
    const ctx: IMoveContext = {
      migration: claimed.migration,
      actor: actorUserId,
      deadlineAt: claimed.deadlineAt,
      relayHeld: false,
      cutOver: false
    };

    try {
      await this.prepare(ctx);
      await this.exportWallet(ctx);
      const moved = await this.importWallet(ctx);
      await this.verify(ctx, moved);
      await this.switchOver(ctx, moved);
    } catch (error) {
      if (ctx.cutOver) {
        await this.finishCutover(ctx);
        return;
      }
      const code = error instanceof MoveFailure ? error.code : 'MOVE_FAILED';
      if (!(error instanceof MoveFailure)) {
        this.logger.error(`[move] ${ctx.migration.id}: unexpected failure: ${this.describe(error)}`);
      }
      await this.abortMove(ctx, code);
      return;
    }

    await this.finishCutover(ctx);
  }

  /**
   * Undoes a move that stopped before the switch (a crash, or a deadline that passed with nobody running it).
   * Safe to repeat: it keeps the org frozen until the held messages are back and the relay is removed.
   * @returns true once the migration is FAILED, false if cleanup is incomplete and must be retried
   */
  async abortInterrupted(migrationId: string, code = 'MOVE_INTERRUPTED'): Promise<boolean> {
    const migration = await this.migrationRepository.getById(migrationId);
    if (!migration) {
      return false;
    }
    const ctx = await this.resumeContext(migration, true);
    return this.abortMove(ctx, code);
  }

  /** Finishes a move that was switched over but never completed. Safe to repeat. */
  async resumeCutover(migrationId: string): Promise<void> {
    const migration = await this.migrationRepository.getById(migrationId);
    if (!migration || OrgAgentMigrationStatus.CUTOVER !== migration.status) {
      return;
    }
    await this.finishCutover(await this.resumeContext(migration, false));
  }

  private async resumeContext(migration: org_agent_migrations, relayHeld: boolean): Promise<IMoveContext> {
    return {
      migration,
      actor: (await this.migrationRepository.getConfirmingActor(migration.id)) ?? migration.startedBy,
      deadlineAt: migration.freezeDeadline?.getTime() ?? Date.now(),
      shared: await this.access.shared(),
      dedicated: await this.access.dedicated(migration),
      relayHeld,
      exportJobId: migration.exportJobId ?? undefined,
      cutOver: OrgAgentMigrationStatus.CUTOVER === migration.status
    };
  }

  // Freezing the org is this status change: every org-initiated agent call checks it.
  private async claim(
    migrationId: string,
    actor: string
  ): Promise<{ migration: org_agent_migrations; deadlineAt: number } | undefined> {
    const migration = await this.migrationRepository.getById(migrationId);
    if (!migration || OrgAgentMigrationStatus.SCHEDULED !== migration.status) {
      return undefined;
    }
    const deadlineAt = Date.now() + (migration.predictedFreezeMs ?? DEFAULT_FREEZE_MS);
    try {
      // Still due: a slot moved, or a rehearsal started, after the scheduler read the row must stop this claim. The
      // rehearsal's key fingerprint is dropped so the trail only shows the move's own once its export exists.
      const frozen = await this.migrationService.advance(
        migrationId,
        OrgAgentMigrationStatus.FROZEN,
        actor,
        { freezeDeadline: new Date(deadlineAt), importKeyFingerprint: null },
        { where: { rehearsalStatus: REHEARSAL_DONE, scheduledFor: { lte: new Date() } } }
      );
      return { migration: frozen, deadlineAt };
    } catch (error) {
      this.logger.warn(`[move] ${migrationId}: not started, ${this.describe(error)}`);
      return undefined;
    }
  }

  private checkBudget(ctx: IMoveContext): void {
    if (Date.now() >= ctx.deadlineAt) {
      throw new MoveFailure('FREEZE_BUDGET_EXCEEDED');
    }
  }

  private async prepare(ctx: IMoveContext): Promise<void> {
    ctx.shared = await this.access.shared();
    ctx.dedicated = await this.access.dedicated(ctx.migration);
    if (!ctx.shared || !ctx.dedicated || !ctx.migration.tenantId) {
      throw new MoveFailure('AGENT_UNAVAILABLE');
    }

    await this.preCheck(ctx);

    // Calls that already hold the org's key keep running; wait for them before the wallet is read.
    await sleep(Math.min(envMs('ORG_MIGRATION_DRAIN_MS', MINUTE_MS), Math.max(ctx.deadlineAt - Date.now(), 0)));
    this.checkBudget(ctx);

    // Set before the call: if the answer is lost, the abort still knows to look for a relay entry.
    ctx.relayHeld = true;
    await this.call('RELAY_FAILED', () =>
      this.agentClient.putRelay(ctx.shared.endpoint, ctx.shared.token, ctx.migration.tenantId, { mode: 'HOLD' })
    );
  }

  // The checks that do not need the imported wallet run first: once the import has happened the target is no longer
  // pristine, so a failure after it leaves the org unable to retry until someone clears that agent.
  private async preCheck(ctx: IMoveContext): Promise<void> {
    const { shared, dedicated, migration } = ctx;
    const [info, sharedInfo] = await Promise.all([
      this.call('VERIFICATION_FAILED:AGENT', () => this.agentClient.getAgentInfo(dedicated.endpoint, dedicated.token)),
      this.call('VERIFICATION_FAILED:AGENT', () => this.agentClient.getAgentInfo(shared.endpoint, shared.token))
    ]);
    this.expect('ENDPOINT', 'PASS' === checkEndpoint(info, migration.targetDidcommEndpoint).status);
    this.expect('RELEASE', 'PASS' === checkRelease(info, sharedInfo).status);
    this.expect('CONFIG', 'PASS' === checkConfig(info, sharedInfo).status);

    const probe = await this.call('VERIFICATION_FAILED:RELAY_PROBE', () =>
      this.agentClient.probeRelayTarget(
        shared.endpoint,
        shared.token,
        migration.tenantId,
        migration.targetDidcommEndpoint
      )
    );
    this.expect('RELAY_PROBE', this.targetHealthy(probe));
  }

  private async exportWallet(ctx: IMoveContext): Promise<void> {
    const { shared, dedicated, migration } = ctx;
    this.checkBudget(ctx);
    ctx.migration = await this.migrationService.advance(migration.id, OrgAgentMigrationStatus.EXPORTING, ctx.actor);

    // The move is a real export of the org's keys, so the alert goes out first and is not optional.
    const alert = await this.alertService.alertKeyExport(ctx.migration, KeyExportAlertKind.MOVE_EXPORT, ctx.actor);
    await this.audit(migration.id, 'MOVE_EXPORT_STARTED', { alertsSent: alert.sent, recipients: alert.recipients });
    if (1 > alert.sent) {
      throw new MoveFailure('ALERT_FAILED');
    }

    const session = await this.call('IMPORT_FAILED', () =>
      this.agentClient.createImportSession(dedicated.endpoint, dedicated.token)
    );
    const importKeyFingerprint = createHash('sha256')
      .update(Buffer.from(session.importPublicKey, 'base64'))
      .digest('hex');

    const job = await this.call('EXPORT_FAILED', () =>
      this.agentClient.startSealedExport(shared.endpoint, shared.token, migration.tenantId, session.importPublicKey)
    );
    ctx.exportJobId = job.jobId;
    // Recorded at once, so an interrupted move can still remove the object from S3.
    await this.migrationRepository.update(migration.id, { exportJobId: job.jobId, importKeyFingerprint });

    const exported = await this.wait('EXPORT', ctx, () =>
      this.agentClient.getExportJob(shared.endpoint, shared.token, migration.tenantId, job.jobId)
    );
    ctx.sessionId = session.sessionId;
    ctx.exported = exported;
  }

  private async importWallet(ctx: IMoveContext): Promise<IMoveCounts> {
    const { dedicated, migration } = ctx;
    const { sessionId, exported } = ctx;
    this.checkBudget(ctx);
    ctx.migration = await this.migrationService.advance(migration.id, OrgAgentMigrationStatus.IMPORTING, ctx.actor, {
      checksum: exported.checksum,
      storageVersion: exported.storageVersion
    });

    // The method preflight settled on, with the final checks run just before the freeze.
    const push = 'PUSH' === ctx.migration.downloadMethod;
    const job = await this.call('IMPORT_FAILED', () =>
      push
        ? this.agentClient.pushImport(
            dedicated.endpoint,
            dedicated.token,
            {
              downloadUrl: exported.downloadUrl,
              sessionId,
              checksum: exported.checksum,
              sealedStoreKey: exported.sealedStoreKey,
              storageVersion: exported.storageVersion,
              dryRun: false
            },
            ctx.deadlineAt - Date.now()
          )
        : this.agentClient.startImport(dedicated.endpoint, dedicated.token, {
            sessionId,
            exportUrl: exported.downloadUrl,
            checksum: exported.checksum,
            sealedStoreKey: exported.sealedStoreKey,
            storageVersion: exported.storageVersion,
            dryRun: false
          })
    );
    await this.migrationRepository.update(migration.id, { importJobId: job.jobId });

    const imported = await this.wait('IMPORT', ctx, () =>
      this.agentClient.getImportJob(dedicated.endpoint, dedicated.token, job.jobId)
    );
    return imported.counts as IMoveCounts;
  }

  // The checks of ADR-WM-006, in order; the first one that fails aborts the move and names itself.
  private async verify(ctx: IMoveContext, moved: IMoveCounts): Promise<void> {
    const { migration } = ctx;
    this.checkBudget(ctx);
    ctx.migration = await this.migrationService.advance(migration.id, OrgAgentMigrationStatus.VERIFYING, ctx.actor);

    const tolerance = Number(process.env.ORG_MIGRATION_COUNT_TOLERANCE ?? 0.2);
    const rehearsal = migration.counts as unknown as IMoveCounts | null;
    this.expect('COUNTS', countsMatchRehearsal(rehearsal, moved, Number.isFinite(tolerance) ? tolerance : 0.2));

    this.expect('SIGN_VERIFY', await this.signAndVerify(ctx));

    await this.audit(migration.id, 'MOVE_VERIFIED', {
      entries: moved.entries,
      keys: moved.keys,
      rehearsalEntries: rehearsal?.entries ?? 0,
      rehearsalKeys: rehearsal?.keys ?? 0
    });
  }

  private expect(check: string, ok: boolean): void {
    if (!ok) {
      throw new MoveFailure(`VERIFICATION_FAILED:${check}`);
    }
  }

  // Proves the moved wallet holds the org DID's signing key. An org with no DID has nothing to prove.
  private async signAndVerify(ctx: IMoveContext): Promise<boolean> {
    const orgDid = (ctx.migration.sourceOrgAgentSnapshot as { orgDid?: string | null } | null)?.orgDid;
    if (!orgDid) {
      return true;
    }
    const { dedicated } = ctx;
    const { credential } = await this.call('VERIFICATION_FAILED:SIGN_VERIFY', () =>
      this.agentClient.createSelfAttestedCredential(dedicated.endpoint, dedicated.token, {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        credentialSubject: {},
        proofType: signingProofType(orgDid),
        did: orgDid
      })
    );
    const issuer = credential?.issuer as string | { id?: string } | undefined;
    if (('string' === typeof issuer ? issuer : issuer?.id) !== orgDid) {
      return false;
    }
    const result = await this.call('VERIFICATION_FAILED:SIGN_VERIFY', () =>
      this.agentClient.verifyCredential(dedicated.endpoint, dedicated.token, credential)
    );
    return true === result?.isValid;
  }

  // The point of no return (ADR-WM-009): the org row and the migration status change in one transaction.
  private async switchOver(ctx: IMoveContext, moved: IMoveCounts): Promise<void> {
    const { migration } = ctx;
    const snapshot = (migration.sourceOrgAgentSnapshot ?? {}) as { agentEndPoint?: string; walletName?: string };
    const [orgAgent, sharedTypeId, dedicatedTypeId] = await Promise.all([
      this.agentServiceRepository.getAgentDetailsByOrgId(migration.orgId),
      this.agentServiceRepository.getOrgAgentTypeDetails(OrgAgentType.SHARED),
      this.agentServiceRepository.getOrgAgentTypeDetails(OrgAgentType.DEDICATED)
    ]);
    if (!orgAgent || !migration.targetTokenEncrypted || !snapshot.agentEndPoint) {
      throw new MoveFailure('AGENT_ROW_CHANGED');
    }

    this.checkBudget(ctx);
    try {
      ctx.migration = await this.migrationRepository.cutover({
        migrationId: migration.id,
        orgId: migration.orgId,
        expectedAgentEndPoint: snapshot.agentEndPoint,
        expectedTenantId: migration.tenantId,
        sharedOrgAgentTypeId: sharedTypeId,
        dedicatedOrgAgentTypeId: dedicatedTypeId,
        agentEndPoint: migration.targetAdminEndpoint,
        encryptedToken: migration.targetTokenEncrypted,
        walletName: snapshot.walletName ?? orgAgent.walletName,
        lastChangedBy: migration.startedBy,
        actor: ctx.actor,
        patch: { counts: moved as never }
      });
    } catch (error) {
      // A refused switch changed nothing; any other failure may or may not have committed, which abortMove re-reads.
      throw new MoveFailure('CUTOVER_FAILED');
    }
    ctx.cutOver = true;
  }

  /**
   * Everything after the switch. Citizens' held messages are the priority, so the relay goes live first; the new
   * invitation and the S3 cleanup follow, and the org is unfrozen last. Each step is repeated a few times and the
   * whole thing can be resumed, because none of it can be undone.
   */
  private async finishCutover(ctx: IMoveContext): Promise<void> {
    const steps: ICompletionStep[] = [
      { name: 'RELAY_FORWARD', run: () => this.forwardRelay(ctx), required: true },
      { name: 'INVITATION', run: () => this.createInvitation(ctx), required: true },
      { name: 'EXPORT_DELETE', run: () => this.removeExport(ctx), required: false },
      { name: 'STABILISE', run: () => this.unfreeze(ctx), required: true }
    ];

    for (const { name, run, required } of steps) {
      try {
        await this.repeat(run);
      } catch (error) {
        this.logger.error(`[move] ${ctx.migration.id}: ${name} failed after the switch: ${this.describe(error)}`);
        await this.audit(ctx.migration.id, 'COMPLETION_STEP_FAILED', { step: name });
        if (required) {
          return;
        }
      }
    }
  }

  private async repeat(step: () => Promise<void>): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt += 1) {
      try {
        await step();
        return;
      } catch (error) {
        last = error;
        if (attempt < COMPLETION_ATTEMPTS) {
          await sleep(envMs('ORG_MIGRATION_RETRY_MS', 2000));
        }
      }
    }
    throw last;
  }

  // The probe counts any HTTP answer as reachable, but a 5xx means nothing healthy is behind the address (a healthy
  // inbound answers the probe's GET with a 404).
  private targetHealthy(probe: { reachable: boolean; status?: number }): boolean {
    return probe.reachable && 500 > (probe.status ?? 0);
  }

  private async forwardRelay(ctx: IMoveContext): Promise<void> {
    const { shared, migration } = ctx;
    if (!shared) {
      throw new MoveFailure('AGENT_UNAVAILABLE');
    }
    // Held messages are delivered to the target as soon as it forwards, so the target is checked again right before:
    // holding is safe (24 hours) and this step is retried and resumed.
    const probe = await this.agentClient.probeRelayTarget(
      shared.endpoint,
      shared.token,
      migration.tenantId,
      migration.targetDidcommEndpoint
    );
    if (!this.targetHealthy(probe)) {
      throw new MoveFailure('TARGET_UNHEALTHY');
    }
    await this.agentClient.putRelay(shared.endpoint, shared.token, migration.tenantId, {
      mode: 'FORWARD',
      target: migration.targetDidcommEndpoint
    });
  }

  // The new reusable invitation, made on the dedicated agent. Existing connections keep matching the old DID.
  private async createInvitation(ctx: IMoveContext): Promise<void> {
    const { migration, dedicated } = ctx;
    const current = await this.migrationRepository.getById(migration.id);
    if (current?.newInvitationDid) {
      return;
    }
    if (!dedicated) {
      throw new MoveFailure('AGENT_UNAVAILABLE');
    }

    const orgAgent = await this.connectionRepository.getAgentEndPoint(migration.orgId);
    const legacy = await this.connectionRepository.getInvitationDidByOrgId(migration.orgId);
    const created = await this.agentClient.createConnectionInvitation(dedicated.endpoint, dedicated.token, {
      multiUseInvitation: true,
      autoAcceptConnection: true,
      label: orgAgent.organisation.name,
      ...(orgAgent.organisation.logoUrl ? { imageUrl: orgAgent.organisation.logoUrl } : {})
    });
    if (!created?.invitationDid || !created.invitationUrl) {
      throw new MoveFailure('INVITATION_FAILED');
    }

    const shortened = await this.connectionService.storeConnectionObjectAndReturnUrl(created.invitationUrl, true);
    // One transaction: a failure between the two writes cannot leave a row that a repeat would duplicate.
    await this.migrationRepository.attachNewInvitation({
      migrationId: migration.id,
      orgId: migration.orgId,
      agentId: orgAgent.id,
      connectionInvitation: shortened,
      newInvitationDid: created.invitationDid,
      legacyInvitationDid: legacy?.invitationDid ?? null
    });
  }

  // The sealed file is useless without the new agent's key and expires in a day anyway; this just tidies up.
  private async removeExport(ctx: IMoveContext): Promise<void> {
    const { shared, migration } = ctx;
    const exportJobId = ctx.exportJobId ?? migration.exportJobId;
    if (!shared || !exportJobId) {
      return;
    }
    await this.deleteExport(shared, migration.tenantId, exportJobId);
  }

  private async unfreeze(ctx: IMoveContext): Promise<void> {
    await this.migrationService.advance(ctx.migration.id, OrgAgentMigrationStatus.STABILISING, ctx.actor, {
      stabilisationEndsAt: new Date(Date.now() + stabilisationMs()),
      // Preflight's probe does not count: the window's own check must show the webhook working now.
      webhookConfirmedAt: null,
      // The token now lives on the org's agent row; the migration no longer needs its own copy.
      targetTokenEncrypted: null
    });
  }

  /**
   * Puts everything back as it was, then marks the migration FAILED. The org stays frozen until the held messages are
   * re-injected and the relay entry is gone, so an incomplete cleanup is retried instead of leaving the org half-moved.
   */
  private async abortMove(ctx: IMoveContext, code: string): Promise<boolean> {
    const current = await this.migrationRepository.getById(ctx.migration.id);
    if (!current || !isAbortable(current.status as OrgAgentMigrationStatus)) {
      // Already switched over (a cutover whose answer was lost), or already finished: there is nothing to undo.
      if (current && OrgAgentMigrationStatus.CUTOVER === current.status) {
        ctx.cutOver = true;
        ctx.migration = current;
        await this.finishCutover(ctx);
      }
      return false;
    }

    const { shared } = ctx;
    const exportJobId = ctx.exportJobId ?? current.exportJobId;

    let clean = true;
    let reinjected: { injected: number; failed: number } | undefined;
    if (ctx.relayHeld && shared && current.tenantId) {
      ({ clean, reinjected } = await this.clearRelay(shared, current.tenantId));
    }

    if (!clean) {
      this.logger.error(`[move] ${current.id}: abort is incomplete; the org stays frozen until the relay is cleared`);
      await this.audit(current.id, 'MOVE_ABORT_INCOMPLETE', { code });
      return false;
    }

    try {
      await this.migrationService.abort(current.id, code, null);
    } catch (error) {
      this.logger.error(`[move] ${current.id}: could not mark the move failed: ${this.describe(error)}`);
      return false;
    }
    await this.audit(current.id, 'MOVE_ABORTED', {
      code,
      reinjected: reinjected?.injected ?? 0,
      reinjectFailed: reinjected?.failed ?? 0
    });

    // After the messages are back and the org is unfrozen: it may wait for a running export to finish.
    if (shared && exportJobId) {
      await this.deleteExport(shared, current.tenantId, exportJobId);
    }
    return true;
  }

  /**
   * Hands the held messages back and removes the relay. A relay that was refused removal because messages arrived
   * after the hand-back is emptied again and retried; one that is busy, or whose agent cannot be reached, leaves the
   * abort incomplete so the scheduler retries it. Only a relay that is not there needs no cleanup.
   */
  private async clearRelay(
    shared: IAgentAccess,
    tenantId: string
  ): Promise<{ clean: boolean; reinjected?: { injected: number; failed: number } }> {
    const total = { injected: 0, failed: 0 };
    for (let attempt = 0; attempt < RELAY_CLEAR_ATTEMPTS; attempt += 1) {
      try {
        const back = await this.agentClient.reinjectRelay(shared.endpoint, shared.token, tenantId);
        total.injected += back.injected;
        total.failed += back.failed;
      } catch (error) {
        if (this.isGone(error)) {
          return { clean: true, reinjected: total };
        }
        if (!this.isAgentCode(error, 'RELAY_NOT_HOLDING')) {
          return { clean: false, reinjected: total };
        }
      }
      // Never remove the relay while held messages may still be in it: that would drop them.
      try {
        await this.agentClient.deleteRelay(shared.endpoint, shared.token, tenantId);
        return { clean: true, reinjected: total };
      } catch (error) {
        if (this.isGone(error)) {
          return { clean: true, reinjected: total };
        }
        if (!this.isAgentCode(error, 'RELAY_BUFFER_NOT_EMPTY')) {
          return { clean: false, reinjected: total };
        }
      }
    }
    return { clean: false, reinjected: total };
  }

  private isGone(error: unknown): boolean {
    return error instanceof MigrationAgentError && 'NOT_FOUND' === error.kind;
  }

  private isAgentCode(error: unknown, code: string): boolean {
    return error instanceof MigrationAgentError && 'CONFLICT' === error.kind && code === error.agentCode;
  }

  // The agent refuses to delete an export that is still running, so a job cut short is given time to finish first.
  private async deleteExport(shared: IAgentAccess, tenantId: string, jobId: string): Promise<void> {
    const deadline = Date.now() + envMs('ORG_MIGRATION_EXPORT_CLEANUP_WAIT_MS', 2 * MINUTE_MS);
    for (;;) {
      try {
        const job = await this.agentClient.getExportJob(shared.endpoint, shared.token, tenantId, jobId);
        if ('completed' === job.status || 'failed' === job.status || Date.now() >= deadline) {
          break;
        }
      } catch {
        break;
      }
      await sleep(envMs('ORG_MIGRATION_POLL_INTERVAL_MS', 5000));
    }
    try {
      await this.agentClient.deleteExport(shared.endpoint, shared.token, tenantId, jobId);
    } catch (error) {
      // A 404 is either an export already removed or an agent without the delete route, so it is not silent.
      this.logger.warn(`[move] export ${jobId} was not deleted from S3: ${this.describe(error)}`);
    }
  }

  // Polls a job, within both the job timeout and what is left of the freeze budget.
  private async wait(
    step: 'EXPORT' | 'IMPORT',
    ctx: IMoveContext,
    fetchJob: () => Promise<IPortabilityJob>
  ): Promise<IPortabilityJob> {
    try {
      return await pollJob(fetchJob, Math.min(Date.now() + jobTimeoutMs(), ctx.deadlineAt));
    } catch (error) {
      if (error instanceof JobPollFailure) {
        if ('JOB_FAILED' === error.reason) {
          throw new MoveFailure(`${step}_FAILED`);
        }
        if ('TIMEOUT' === error.reason) {
          throw new MoveFailure(Date.now() >= ctx.deadlineAt ? 'FREEZE_BUDGET_EXCEEDED' : `${step}_TIMEOUT`);
        }
        throw new MoveFailure(this.agentFailureCode(error.cause, `${step}_FAILED`));
      }
      throw error;
    }
  }

  private async call<T>(fallbackCode: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw new MoveFailure(this.agentFailureCode(error, fallbackCode));
    }
  }

  private agentFailureCode(error: unknown, fallbackCode: string): string {
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
    return fallbackCode;
  }

  private async audit(
    migrationId: string,
    action: string,
    detail: Record<string, string | number | boolean>
  ): Promise<void> {
    try {
      await this.migrationRepository.recordEvent(migrationId, { action, actor: null, detail });
    } catch (error) {
      this.logger.error(`[move] could not audit ${action}: ${this.describe(error)}`);
    }
  }

  // Only the message: an error from an agent call must never be logged whole.
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'failed';
  }
}
