/* eslint-disable camelcase */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, org_agent_migrations } from '@prisma/client';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';
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
          data: { migrationId: migration.id, fromStatus: null, toStatus: migration.status, actor: params.startedBy }
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
  }): Promise<MigrationRow> {
    const { id, from, to, actor, patch } = params;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.org_agent_migrations.updateMany({
          where: { id, status: from },
          data: {
            ...patch,
            status: to,
            lastChangedDateTime: new Date()
          }
        });
        if (1 !== count) {
          throw new ConflictException(ResponseMessages.agent.error.migrationStateChanged);
        }
        await tx.org_agent_migration_events.create({
          data: { migrationId: id, fromStatus: from, toStatus: to, actor }
        });
        return tx.org_agent_migrations.findUniqueOrThrow({ where: { id } });
      });
    } catch (error) {
      this.logger.error(
        `[OrgAgentMigrationRepository.transition] - ${from} -> ${to}: ${error instanceof Error ? error.message : 'failed'}`
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
        actor: entry.actor,
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
