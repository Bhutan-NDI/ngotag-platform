/* eslint-disable camelcase */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrgAgentMigrationStatus, OrgAgentType } from '@credebl/enum/enum';
import { RpcException } from '@nestjs/microservices';
import { org_agent_migrations } from '@prisma/client';
import { ResponseMessages } from '@credebl/common/response-messages';
import { AgentServiceRepository } from '../repositories/agent-service.repository';
import { OrgAgentMigrationPatch, OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { ICreateOrgAgentMigration, IListOrgAgentMigrations } from './org-agent-migration.interface';
import { canTransition, isAbortable } from './org-agent-migration.state-machine';
import { isHttpsUrl, normaliseDidcommEndpoint } from './org-agent-migration.endpoint';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Owns the lifecycle of an org's move from the shared agent to a dedicated one: creating it, reading it, and
 * every status change. The steps that do the work (preflight, rehearsal, move day, rotation) drive it through
 * `advance` and `abort`, so no step can skip a state or move a migration that has already finished.
 */
@Injectable()
export class OrgAgentMigrationService {
  constructor(
    private readonly agentServiceRepository: AgentServiceRepository,
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly logger: Logger
  ) {}

  async createMigration(payload: ICreateOrgAgentMigration): Promise<org_agent_migrations> {
    try {
      const { orgId, userId, targetAdminEndpoint } = payload;
      const targetDidcommEndpoint = normaliseDidcommEndpoint(payload.targetDidcommEndpoint);

      if (
        !isHttpsUrl(targetAdminEndpoint) ||
        !targetDidcommEndpoint ||
        new URL(targetAdminEndpoint).origin === new URL(targetDidcommEndpoint).origin
      ) {
        throw new BadRequestException(ResponseMessages.agent.error.migrationEndpointInvalid);
      }

      const orgAgent = await this.agentServiceRepository.getAgentDetailsByOrgId(orgId);
      if (!orgAgent) {
        throw new NotFoundException(ResponseMessages.agent.error.agentNotExists);
      }
      const sharedTypeId = await this.agentServiceRepository.getOrgAgentTypeDetails(OrgAgentType.SHARED);
      if (orgAgent.orgAgentTypeId !== sharedTypeId) {
        throw new BadRequestException(ResponseMessages.agent.error.migrationOrgNotShared);
      }

      return await this.migrationRepository.create({
        orgId,
        startedBy: userId,
        tenantId: orgAgent.tenantId,
        // What the org looked like before the move, for the audit trail and a manual restore. No secrets.
        sourceOrgAgentSnapshot: {
          orgAgentTypeId: orgAgent.orgAgentTypeId,
          agentEndPoint: orgAgent.agentEndPoint,
          tenantId: orgAgent.tenantId,
          walletName: orgAgent.walletName,
          orgDid: orgAgent.orgDid,
          ledgerId: orgAgent.ledgerId,
          agentId: orgAgent.agentId,
          agentsTypeId: orgAgent.agentsTypeId,
          isDidPublic: orgAgent.isDidPublic
        },
        targetAdminEndpoint,
        targetDidcommEndpoint
      });
    } catch (error) {
      this.logger.error(`[createMigration] - error: ${error instanceof Error ? error.message : 'failed'}`);
      throw new RpcException(error.response ?? error);
    }
  }

  async getMigration(orgId: string): Promise<org_agent_migrations> {
    try {
      const migration = await this.migrationRepository.getLatestByOrgId(orgId);
      if (!migration) {
        throw new NotFoundException(ResponseMessages.agent.error.migrationNotFound);
      }
      return migration;
    } catch (error) {
      throw new RpcException(error.response ?? error);
    }
  }

  async listMigrations(
    payload: IListOrgAgentMigrations
  ): Promise<{ total: number; migrations: org_agent_migrations[] }> {
    try {
      const pageSize = Math.min(Math.max(payload.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      const pageNumber = Math.max(payload.pageNumber ?? 1, 1);
      return await this.migrationRepository.list({
        orgId: payload.orgId,
        status: payload.status,
        skip: (pageNumber - 1) * pageSize,
        take: pageSize
      });
    } catch (error) {
      throw new RpcException(error.response ?? error);
    }
  }

  /**
   * Moves a migration to its next state. Throws when the state machine does not allow it from the
   * migration's current state, or when another actor moved it first.
   * @param actor user id, or null for a system step such as a timer
   * @param options.expectedFrom the status the caller read: when the migration is no longer in it, a stale caller is
   * refused instead of moving the row from whatever state it is in now
   */
  async advance(
    migrationId: string,
    to: OrgAgentMigrationStatus,
    actor: string | null,
    patch?: OrgAgentMigrationPatch,
    options: Pick<Parameters<OrgAgentMigrationRepository['transition']>[0], 'where' | 'event'> & {
      expectedFrom?: OrgAgentMigrationStatus;
    } = {}
  ): Promise<org_agent_migrations> {
    const migration = await this.migrationRepository.getById(migrationId);
    if (!migration) {
      throw new NotFoundException(ResponseMessages.agent.error.migrationNotFound);
    }
    const { expectedFrom, ...transitionOptions } = options;
    const from = migration.status as OrgAgentMigrationStatus;
    if (expectedFrom && expectedFrom !== from) {
      throw new ConflictException(ResponseMessages.agent.error.migrationStateChanged);
    }
    if (!canTransition(from, to)) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationInvalidTransition);
    }
    return this.migrationRepository.transition({ id: migrationId, from, to, actor, patch, ...transitionOptions });
  }

  /**
   * Fails a scheduled or started migration that has not reached the switch: the org stays exactly as it was. `errorCode` is a
   * stable, sanitised code (for example VERIFICATION_FAILED), never raw error text. The stored token for the
   * dedicated agent is dropped: a finished migration has no use for a credential.
   */
  async abort(migrationId: string, errorCode: string, actor: string | null): Promise<org_agent_migrations> {
    const migration = await this.migrationRepository.getById(migrationId);
    if (!migration) {
      throw new NotFoundException(ResponseMessages.agent.error.migrationNotFound);
    }
    if (!isAbortable(migration.status as OrgAgentMigrationStatus)) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationInvalidTransition);
    }
    return this.migrationRepository.transition({
      id: migrationId,
      from: migration.status as OrgAgentMigrationStatus,
      to: OrgAgentMigrationStatus.FAILED,
      actor,
      patch: { error: errorCode, targetTokenEncrypted: null }
    });
  }
}
