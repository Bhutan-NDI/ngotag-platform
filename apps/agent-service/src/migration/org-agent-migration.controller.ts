/* eslint-disable camelcase */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { RpcException } from '@nestjs/microservices';
import { OrgAgentMigrationService } from './org-agent-migration.service';
import { OrgAgentMigrationPreflightService } from './org-agent-migration.preflight.service';
import { OrgAgentMigrationRehearsalService } from './org-agent-migration.rehearsal.service';
import {
  ICreateOrgAgentMigration,
  IListOrgAgentMigrations,
  IOrgAgentMigration,
  IPreflightOrgAgentMigration,
  IPreflightReport,
  IRehearseOrgAgentMigration,
  toPublicMigration
} from './org-agent-migration.interface';

/**
 * NATS entry points for the org agent migration. Who may call them (owner, platform admin) is enforced at the
 * gateway; these handlers trust the payload they are given.
 */
@Controller()
export class OrgAgentMigrationController {
  constructor(
    private readonly migrationService: OrgAgentMigrationService,
    private readonly preflightService: OrgAgentMigrationPreflightService,
    private readonly rehearsalService: OrgAgentMigrationRehearsalService,
    private readonly logger: Logger
  ) {}

  // Creates the migration and runs the first preflight, so the owner sees the checks as soon as it exists.
  @MessagePattern({ cmd: 'migrate-org-agent' })
  async createMigration(
    payload: ICreateOrgAgentMigration
  ): Promise<{ migration: IOrgAgentMigration; preflight: IPreflightReport | null }> {
    const created = await this.migrationService.createMigration(payload);
    try {
      const { migration, report } = await this.preflightService.run(created.id, payload);
      return { migration: toPublicMigration(migration), preflight: report };
    } catch (error) {
      // The migration exists; the owner can re-run the checks.
      this.logger.error(
        `[migrate-org-agent] preflight did not run: ${error instanceof Error ? error.message : 'failed'}`
      );
      return { migration: toPublicMigration(created), preflight: null };
    }
  }

  @MessagePattern({ cmd: 'preflight-org-agent-migration' })
  async preflight(
    payload: IPreflightOrgAgentMigration
  ): Promise<{ migration: IOrgAgentMigration; preflight: IPreflightReport }> {
    try {
      const active = await this.migrationService.getMigration(payload.orgId);
      const { migration, report } = await this.preflightService.run(active.id, payload);
      return { migration: toPublicMigration(migration), preflight: report };
    } catch (error) {
      throw error instanceof RpcException ? error : new RpcException(error.response ?? error);
    }
  }

  @MessagePattern({ cmd: 'rehearse-org-agent-migration' })
  async rehearse(payload: IRehearseOrgAgentMigration): Promise<IOrgAgentMigration> {
    try {
      return toPublicMigration(await this.rehearsalService.start(payload.orgId, payload.userId));
    } catch (error) {
      throw new RpcException(error.response ?? error);
    }
  }

  @MessagePattern({ cmd: 'get-org-agent-migration' })
  async getMigration(payload: { orgId: string }): Promise<IOrgAgentMigration> {
    return toPublicMigration(await this.migrationService.getMigration(payload.orgId));
  }

  @MessagePattern({ cmd: 'list-org-agent-migrations' })
  async listMigrations(payload: IListOrgAgentMigrations): Promise<{ total: number; migrations: IOrgAgentMigration[] }> {
    const { total, migrations } = await this.migrationService.listMigrations(payload);
    return { total, migrations: migrations.map(toPublicMigration) };
  }
}
