/* eslint-disable camelcase */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, org_agent_migrations } from '@prisma/client';
import { ORG_AGENT_MIGRATION_FROZEN_STATUSES, OrgAgentMigrationStatus } from '@credebl/enum/enum';
import { PrismaService } from '@credebl/prisma-service';
import { ResponseMessages } from '@credebl/common/response-messages';
import { FileUploadStatus } from 'apps/api-gateway/src/enum';
import { OrgRoles } from 'libs/org-roles/enums';
import { TERMINAL_STATUSES } from '../migration/org-agent-migration.state-machine';

type MigrationRow = org_agent_migrations;

// Everything a step may record on the row except what the state machine owns.
export type OrgAgentMigrationPatch = Omit<
  Prisma.org_agent_migrationsUncheckedUpdateManyInput,
  'id' | 'orgId' | 'status' | 'createDateTime' | 'lastChangedDateTime'
>;

const UNIQUE_VIOLATION = 'P2002';
export const REHEARSAL_RUNNING = 'RUNNING';
export const REHEARSAL_DONE = 'DONE';

// Named on every audit entry no person made: the timer, a recovery, a failed move.
export const SYSTEM_ACTOR = 'SYSTEM';

// What every state change carries once the export exists (SAD §7.7): the checksum of what was handed over and the
// fingerprint of the key it was sealed to. Neither is a secret.
const custodyFacts = (row: MigrationRow): Prisma.InputJsonObject => ({
  ...(row.checksum ? { checksum: row.checksum } : {}),
  ...(row.importKeyFingerprint ? { importKeyFingerprint: row.importKeyFingerprint } : {})
});

const withDetail = (facts: Prisma.InputJsonObject): { detail?: Prisma.InputJsonObject } =>
  0 < Object.keys(facts).length ? { detail: facts } : {};

@Injectable()
export class OrgAgentMigrationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger
  ) {}

  /**
   * Creates a migration in CREATED, with its first event. The partial unique index on orgId rejects a second
   * non-terminal migration for the same org.
   * @throws ConflictException when the org already has an active migration
   */
  async create(params: {
    orgId: string;
    startedBy: string;
    tenantId: string | null;
    sourceOrgAgentSnapshot: Prisma.InputJsonValue;
    targetAdminEndpoint: string;
    targetDidcommEndpoint: string;
  }): Promise<MigrationRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const migration = await tx.org_agent_migrations.create({
          data: {
            orgId: params.orgId,
            startedBy: params.startedBy,
            status: OrgAgentMigrationStatus.CREATED,
            tenantId: params.tenantId,
            sourceOrgAgentSnapshot: params.sourceOrgAgentSnapshot,
            targetAdminEndpoint: params.targetAdminEndpoint,
            targetDidcommEndpoint: params.targetDidcommEndpoint
          }
        });
        await tx.org_agent_migration_events.create({
          data: {
            migrationId: migration.id,
            fromStatus: null,
            toStatus: migration.status,
            actor: params.startedBy
          }
        });
        return migration;
      });
    } catch (error) {
      if (UNIQUE_VIOLATION === error?.code) {
        throw new ConflictException(ResponseMessages.agent.error.migrationAlreadyActive);
      }
      this.logger.error(`[OrgAgentMigrationRepository.create] - ${error instanceof Error ? error.message : 'failed'}`);
      throw error;
    }
  }

  async getById(id: string): Promise<MigrationRow | null> {
    return this.prisma.org_agent_migrations.findUnique({ where: { id } });
  }

  async getActiveByOrgId(orgId: string): Promise<MigrationRow | null> {
    return this.prisma.org_agent_migrations.findFirst({
      where: { orgId, status: { notIn: [...TERMINAL_STATUSES] } }
    });
  }

  // The active migration if there is one, otherwise the most recent finished one.
  async getLatestByOrgId(orgId: string): Promise<MigrationRow | null> {
    return (
      (await this.getActiveByOrgId(orgId)) ??
      this.prisma.org_agent_migrations.findFirst({ where: { orgId }, orderBy: { createDateTime: 'desc' } })
    );
  }

  async list(params: {
    orgId?: string;
    status?: OrgAgentMigrationStatus;
    skip: number;
    take: number;
  }): Promise<{ total: number; migrations: MigrationRow[] }> {
    const where: Prisma.org_agent_migrationsWhereInput = {
      ...(params.orgId ? { orgId: params.orgId } : {}),
      ...(params.status ? { status: params.status } : {})
    };
    const [total, migrations] = await this.prisma.$transaction([
      this.prisma.org_agent_migrations.count({ where }),
      this.prisma.org_agent_migrations.findMany({
        where,
        orderBy: { createDateTime: 'desc' },
        skip: params.skip,
        take: params.take
      })
    ]);
    return { total, migrations };
  }

  /**
   * Moves a migration from one state to another and records the transition, in one transaction. The update
   * only matches while the row is still in `from`, so two actors racing on the same migration cannot both win.
   * The caller has already checked the transition is allowed by the state machine.
   * @throws ConflictException when the migration is no longer in `from`
   */
  async transition(params: {
    id: string;
    from: OrgAgentMigrationStatus;
    to: OrgAgentMigrationStatus;
    actor: string | null;
    patch?: OrgAgentMigrationPatch;
    // Conditions the row must still meet, beyond being in `from`.
    where?: Prisma.org_agent_migrationsWhereInput;
    // Written as the transition's own audit entry, so it cannot be lost on its own.
    event?: { action: string; detail?: Prisma.InputJsonValue };
  }): Promise<MigrationRow> {
    const { id, from, to, actor, patch, where, event } = params;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.org_agent_migrations.updateMany({
          where: { id, status: from, ...where },
          data: {
            ...patch,
            status: to,
            lastChangedDateTime: new Date(),
            ...(OrgAgentMigrationStatus.COMPLETED === to ? { completedAt: new Date() } : {})
          }
        });
        if (1 !== count) {
          throw new ConflictException(ResponseMessages.agent.error.migrationStateChanged);
        }
        const row = await tx.org_agent_migrations.findUniqueOrThrow({ where: { id } });
        await tx.org_agent_migration_events.create({
          data: {
            migrationId: id,
            fromStatus: from,
            toStatus: to,
            actor: actor ?? SYSTEM_ACTOR,
            ...(event ? { action: event.action } : {}),
            ...withDetail({ ...custodyFacts(row), ...((event?.detail ?? {}) as Prisma.InputJsonObject) })
          }
        });
        return row;
      });
    } catch (error) {
      this.logger.error(
        `[OrgAgentMigrationRepository.transition] - ${from} -> ${to}: ${error instanceof Error ? error.message : 'failed'}`
      );
      throw error;
    }
  }

  /**
   * The switch (ADR-WM-009): points the org's agent row at the dedicated agent and moves the migration to CUTOVER in
   * one transaction. Done together so a crash cannot leave the org on the new agent while the migration still says it
   * can be aborted. The agent row only matches while it is still the shared one the move was prepared against.
   * @throws ConflictException when the agent row or the migration changed in the meantime; nothing is written
   */
  async cutover(params: {
    migrationId: string;
    orgId: string;
    expectedAgentEndPoint: string;
    expectedTenantId: string;
    sharedOrgAgentTypeId: string;
    dedicatedOrgAgentTypeId: string;
    agentEndPoint: string;
    encryptedToken: string;
    walletName: string;
    lastChangedBy: string;
    actor: string | null;
    patch?: OrgAgentMigrationPatch;
  }): Promise<MigrationRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const agent = await tx.org_agents.updateMany({
          where: {
            orgId: params.orgId,
            orgAgentTypeId: params.sharedOrgAgentTypeId,
            agentEndPoint: params.expectedAgentEndPoint,
            tenantId: params.expectedTenantId
          },
          data: {
            orgAgentTypeId: params.dedicatedOrgAgentTypeId,
            agentEndPoint: params.agentEndPoint,
            apiKey: params.encryptedToken,
            tenantId: null,
            walletName: params.walletName,
            lastChangedBy: params.lastChangedBy,
            lastChangedDateTime: new Date()
          }
        });
        if (1 !== agent.count) {
          throw new ConflictException(ResponseMessages.agent.error.agentRowChangedDuringMigration);
        }

        const migration = await tx.org_agent_migrations.updateMany({
          where: { id: params.migrationId, status: OrgAgentMigrationStatus.VERIFYING },
          data: {
            ...params.patch,
            status: OrgAgentMigrationStatus.CUTOVER,
            lastChangedDateTime: new Date()
          }
        });
        if (1 !== migration.count) {
          throw new ConflictException(ResponseMessages.agent.error.migrationStateChanged);
        }

        const row = await tx.org_agent_migrations.findUniqueOrThrow({ where: { id: params.migrationId } });
        await tx.org_agent_migration_events.create({
          data: {
            migrationId: params.migrationId,
            fromStatus: OrgAgentMigrationStatus.VERIFYING,
            toStatus: OrgAgentMigrationStatus.CUTOVER,
            actor: params.actor ?? SYSTEM_ACTOR,
            ...withDetail(custodyFacts(row))
          }
        });
        return row;
      });
    } catch (error) {
      this.logger.error(`[OrgAgentMigrationRepository.cutover] - ${error instanceof Error ? error.message : 'failed'}`);
      throw error;
    }
  }

  /** Saves the org's new reusable invitation and records its DID on the migration, together or not at all. */
  async attachNewInvitation(params: {
    migrationId: string;
    orgId: string;
    agentId: string;
    connectionInvitation: string;
    newInvitationDid: string;
    legacyInvitationDid: string | null;
  }): Promise<MigrationRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.agent_invitations.create({
        data: {
          orgId: String(params.orgId),
          agentId: params.agentId,
          connectionInvitation: params.connectionInvitation,
          multiUse: true,
          invitationDid: params.newInvitationDid
        }
      });
      return tx.org_agent_migrations.update({
        where: { id: params.migrationId },
        data: {
          newInvitationDid: params.newInvitationDid,
          legacyInvitationDid: params.legacyInvitationDid,
          lastChangedDateTime: new Date()
        }
      });
    });
  }

  /**
   * Takes the lease on a migration unless another replica holds it. The lease expires on its own, so a replica that
   * dies holding it does not block the migration for long.
   * @returns false when someone else holds a live lease
   */
  async tryAcquireLease(id: string, leaseMs: number): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.org_agent_migrations.updateMany({
      where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { leaseUntil: new Date(now.getTime() + leaseMs) }
    });
    return 1 === count;
  }

  /** Frees a lease the caller holds, so a retry is not refused as busy for the rest of it. */
  async releaseLease(id: string): Promise<void> {
    await this.prisma.org_agent_migrations.updateMany({ where: { id }, data: { leaseUntil: null } });
  }

  /**
   * Takes the migration's one webhook probe slot, unless a probe that has not expired is already out.
   * @returns false when another probe is in flight
   */
  async tryBeginWebhookProbe(id: string, probeHash: string, expiresAt: Date, now: Date = new Date()): Promise<boolean> {
    const { count } = await this.prisma.org_agent_migrations.updateMany({
      where: { id, OR: [{ webhookProbeHash: null }, { webhookProbeExpiresAt: { lt: now } }] },
      data: { webhookProbeHash: probeHash, webhookProbeExpiresAt: expiresAt }
    });
    return 1 === count;
  }

  /**
   * The dedicated agent's webhook has reached the platform: consumes the probe, once, if it is the live probe of this
   * org's unfinished migration.
   * @returns false for anything else, which the caller must not distinguish
   */
  async confirmWebhookProbe(orgId: string, probeHash: string, now: Date = new Date()): Promise<boolean> {
    const { count } = await this.prisma.org_agent_migrations.updateMany({
      where: {
        orgId,
        status: { notIn: [...TERMINAL_STATUSES] },
        webhookProbeHash: probeHash,
        webhookProbeExpiresAt: { gt: now }
      },
      data: { webhookProbeHash: null, webhookProbeExpiresAt: null, webhookConfirmedAt: now }
    });
    return 1 === count;
  }

  /** Frees the probe slot if the probe is still the one that took it. */
  async endWebhookProbe(id: string, probeHash: string): Promise<void> {
    await this.prisma.org_agent_migrations.updateMany({
      where: { id, webhookProbeHash: probeHash },
      data: { webhookProbeHash: null, webhookProbeExpiresAt: null }
    });
  }

  /** Migrations in an open stabilisation window whose webhook has not been confirmed and is due another try. */
  async findAwaitingWebhook(now: Date, retryBefore: Date, take: number): Promise<MigrationRow[]> {
    return this.prisma.org_agent_migrations.findMany({
      where: {
        status: OrgAgentMigrationStatus.STABILISING,
        webhookConfirmedAt: null,
        stabilisationEndsAt: { gt: now },
        OR: [{ webhookCheckedAt: null }, { webhookCheckedAt: { lt: retryBefore } }]
      },
      orderBy: { stabilisationEndsAt: 'asc' },
      take
    });
  }

  /**
   * Takes this try at the window's webhook check, unless another replica took it within the retry spacing. Kept apart
   * from the lease so that a failing check never holds up a disaster restore.
   * @returns false when someone else has the try
   */
  async tryBeginWebhookCheck(id: string, now: Date, retryBefore: Date): Promise<boolean> {
    const { count } = await this.prisma.org_agent_migrations.updateMany({
      where: { id, OR: [{ webhookCheckedAt: null }, { webhookCheckedAt: { lt: retryBefore } }] },
      data: { webhookCheckedAt: now }
    });
    return 1 === count;
  }

  /** Scheduled moves whose slot has arrived, earliest first. Only a finished rehearsal counts as ready. */
  async findDueForStart(now: Date, take: number): Promise<MigrationRow[]> {
    return this.prisma.org_agent_migrations.findMany({
      where: {
        status: OrgAgentMigrationStatus.SCHEDULED,
        rehearsalStatus: REHEARSAL_DONE,
        scheduledFor: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
      },
      orderBy: { scheduledFor: 'asc' },
      take
    });
  }

  /** Moves in the stabilisation window whose window has ended, earliest first. */
  async findWindowEnded(now: Date, take: number): Promise<MigrationRow[]> {
    return this.prisma.org_agent_migrations.findMany({
      where: {
        status: OrgAgentMigrationStatus.STABILISING,
        stabilisationEndsAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
      },
      orderBy: { stabilisationEndsAt: 'asc' },
      take
    });
  }

  /** Moves whose connections are being rotated, oldest first. */
  async findRotating(now: Date, take: number): Promise<MigrationRow[]> {
    return this.prisma.org_agent_migrations.findMany({
      where: {
        status: OrgAgentMigrationStatus.ROTATING,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
      },
      orderBy: { createDateTime: 'asc' },
      take
    });
  }

  /**
   * Moves that nobody seems to be running any more: frozen past their deadline, or switched over without finishing.
   * `graceMs` leaves room for a live run that is about to give up or finish on its own.
   */
  async findStalled(now: Date, graceMs: number): Promise<MigrationRow[]> {
    const cutoff = new Date(now.getTime() - graceMs);
    return this.prisma.org_agent_migrations.findMany({
      where: {
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          {
            OR: [
              {
                status: {
                  in: [
                    OrgAgentMigrationStatus.FROZEN,
                    OrgAgentMigrationStatus.EXPORTING,
                    OrgAgentMigrationStatus.IMPORTING,
                    OrgAgentMigrationStatus.VERIFYING
                  ]
                },
                freezeDeadline: { lt: cutoff }
              },
              { status: OrgAgentMigrationStatus.CUTOVER, lastChangedDateTime: { lt: cutoff } }
            ]
          }
        ]
      }
    });
  }

  /** Moves that hold an org frozen right now, across every replica. */
  async countInFlight(): Promise<number> {
    return this.prisma.org_agent_migrations.count({
      where: { status: { in: [...ORG_AGENT_MIGRATION_FROZEN_STATUSES] } }
    });
  }

  /** Who confirmed the move most recently: the owner the export alert should name. */
  async getConfirmingActor(migrationId: string): Promise<string | null> {
    const event = await this.prisma.org_agent_migration_events.findFirst({
      where: { migrationId, action: 'MOVE_CONFIRMED' },
      orderBy: { createDateTime: 'desc' },
      select: { actor: true }
    });
    return event?.actor ?? null;
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const admin = await this.prisma.user_org_roles.findFirst({
      where: { userId, orgRole: { name: OrgRoles.PLATFORM_ADMIN } },
      select: { id: true }
    });
    return Boolean(admin);
  }

  /**
   * Gives the org back to the shared agent (SAD E.7): the org's agent row is set back to what it was before the move,
   * the migration becomes DISASTER_RESTORED, and the invitation made on the lost agent is removed, all in one
   * transaction. The agent row only matches while it is still the dedicated one the move created; its token is cleared
   * so the platform mints a fresh tenant token from the base wallet, as it does for any shared org.
   * @throws ConflictException when the agent row or the migration changed in the meantime; nothing is written
   */
  async restoreOrgAgent(params: {
    migrationId: string;
    orgId: string;
    expectedAgentEndPoint: string;
    sharedOrgAgentTypeId: string;
    dedicatedOrgAgentTypeId: string;
    agentEndPoint: string;
    tenantId: string;
    walletName: string;
    lastChangedBy: string;
    actor: string;
    newInvitationDid: string | null;
  }): Promise<{ migration: MigrationRow; invitationsRemoved: number }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const agent = await tx.org_agents.updateMany({
          where: {
            orgId: params.orgId,
            orgAgentTypeId: params.dedicatedOrgAgentTypeId,
            agentEndPoint: params.expectedAgentEndPoint
          },
          data: {
            orgAgentTypeId: params.sharedOrgAgentTypeId,
            agentEndPoint: params.agentEndPoint,
            tenantId: params.tenantId,
            walletName: params.walletName,
            apiKey: null,
            lastChangedBy: params.lastChangedBy,
            lastChangedDateTime: new Date()
          }
        });
        if (1 !== agent.count) {
          throw new ConflictException(ResponseMessages.agent.error.agentRowChangedDuringMigration);
        }

        const migration = await tx.org_agent_migrations.updateMany({
          where: { id: params.migrationId, status: OrgAgentMigrationStatus.STABILISING },
          data: {
            status: OrgAgentMigrationStatus.DISASTER_RESTORED,
            error: null,
            lastChangedDateTime: new Date()
          }
        });
        if (1 !== migration.count) {
          throw new ConflictException(ResponseMessages.agent.error.migrationStateChanged);
        }

        const restored = await tx.org_agent_migrations.findUniqueOrThrow({ where: { id: params.migrationId } });
        await tx.org_agent_migration_events.create({
          data: {
            migrationId: params.migrationId,
            fromStatus: OrgAgentMigrationStatus.STABILISING,
            toStatus: OrgAgentMigrationStatus.DISASTER_RESTORED,
            actor: params.actor,
            ...withDetail(custodyFacts(restored))
          }
        });

        const removed = params.newInvitationDid
          ? await tx.agent_invitations.deleteMany({
              where: { orgId: params.orgId, invitationDid: params.newInvitationDid }
            })
          : { count: 0 };
        return { migration: restored, invitationsRemoved: removed.count };
      });
    } catch (error) {
      this.logger.error(
        `[OrgAgentMigrationRepository.restoreOrgAgent] - ${error instanceof Error ? error.message : 'failed'}`
      );
      throw error;
    }
  }

  /** Records facts on a migration that is not changing state (a preflight run, a rehearsal outcome). */
  async update(id: string, patch: OrgAgentMigrationPatch): Promise<MigrationRow> {
    return this.prisma.org_agent_migrations.update({
      where: { id },
      data: { ...patch, lastChangedDateTime: new Date() }
    });
  }

  /**
   * Marks a rehearsal as running unless one already is. A run that started before `staleBefore` is treated as dead
   * (the process died mid-rehearsal) and may be replaced.
   * @returns false when a live rehearsal already holds it
   */
  async tryStartRehearsal(id: string, staleBefore: Date): Promise<boolean> {
    const { count } = await this.prisma.org_agent_migrations.updateMany({
      where: {
        id,
        OR: [
          { rehearsalStatus: null },
          { rehearsalStatus: { not: REHEARSAL_RUNNING } },
          { rehearsalStartedAt: { lt: staleBefore } }
        ]
      },
      data: {
        rehearsalStatus: REHEARSAL_RUNNING,
        rehearsalStartedAt: new Date(),
        rehearsal: Prisma.JsonNull,
        lastChangedDateTime: new Date()
      }
    });
    return 1 === count;
  }

  /** True while the org has a bulk issuance that has started or been restarted and not yet finished. */
  async hasActiveBulkIssuance(orgId: string): Promise<boolean> {
    const active = await this.prisma.file_upload.findFirst({
      where: { orgId, deletedAt: null, status: { in: [FileUploadStatus.started, FileUploadStatus.retry] } },
      select: { id: true }
    });
    return Boolean(active);
  }

  /** How many OID4VC, x509, AnonCreds and status-list records the org has; the move supports none of them. */
  async countOutOfScopeArtefacts(orgId: string): Promise<Record<string, number>> {
    const [oidcIssuers, oid4vpVerifiers, x509Certificates, credentialDefinitions, statusLists] = await Promise.all([
      this.prisma.oidc_issuer.count({ where: { orgAgent: { orgId } } }),
      this.prisma.oid4vp_verifier.count({ where: { orgAgent: { orgId } } }),
      this.prisma.x509_certificates.count({ where: { org_agents: { orgId } } }),
      this.prisma.credential_definition.count({ where: { orgId } }),
      this.prisma.status_list_allocation.count({ where: { orgId } })
    ]);
    return { oidcIssuers, oid4vpVerifiers, x509Certificates, credentialDefinitions, statusLists };
  }

  /**
   * Appends an audit entry for something other than a state change. Never put secrets, URLs or tokens in `detail`.
   */
  async recordEvent(
    migrationId: string,
    entry: { action: string; actor: string | null; detail?: Prisma.InputJsonValue }
  ): Promise<void> {
    const migration = await this.prisma.org_agent_migrations.findUnique({
      where: { id: migrationId },
      select: { status: true }
    });
    if (!migration) {
      return;
    }
    await this.prisma.org_agent_migration_events.create({
      data: {
        migrationId,
        fromStatus: migration.status,
        toStatus: migration.status,
        actor: entry.actor ?? SYSTEM_ACTOR,
        action: entry.action,
        ...(entry.detail === undefined ? {} : { detail: entry.detail })
      }
    });
  }

  async isOrgOwner(orgId: string, userId: string): Promise<boolean> {
    const owner = await this.prisma.user_org_roles.findFirst({
      where: { orgId, userId, orgRole: { name: OrgRoles.OWNER } },
      select: { id: true }
    });
    return Boolean(owner);
  }

  async getOrgName(orgId: string): Promise<string | null> {
    const organisation = await this.prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true } });
    return organisation?.name ?? null;
  }

  async getUserEmail(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return user?.email ?? null;
  }

  /** Who hears about a key export: the org's owners and every member of the platform-admin organisation. */
  async getExportAlertRecipients(orgId: string, platformAdminOrgName: string): Promise<string[]> {
    const memberships = await this.prisma.user_org_roles.findMany({
      where: {
        OR: [{ orgId, orgRole: { name: OrgRoles.OWNER } }, { organisation: { name: platformAdminOrgName } }]
      },
      select: { user: { select: { email: true } } }
    });
    return [
      ...new Set(
        memberships
          .map(({ user }) => user?.email?.trim().toLowerCase())
          .filter((email): email is string => Boolean(email))
      )
    ];
  }
}
