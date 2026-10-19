/* eslint-disable camelcase */
import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { org_agent_migrations } from '@prisma/client';
import { OrgAgentMigrationService } from './org-agent-migration.service';
import { ICreateOrgAgentMigration, IListOrgAgentMigrations } from './org-agent-migration.interface';

/**
 * NATS entry points for the org agent migration. Who may call them (owner, platform admin) is enforced at the
 * gateway; these handlers trust the payload they are given.
 */
@Controller()
export class OrgAgentMigrationController {
  constructor(private readonly migrationService: OrgAgentMigrationService) {}

  @MessagePattern({ cmd: 'migrate-org-agent' })
  async createMigration(payload: ICreateOrgAgentMigration): Promise<org_agent_migrations> {
    return this.migrationService.createMigration(payload);
  }

  @MessagePattern({ cmd: 'get-org-agent-migration' })
  async getMigration(payload: { orgId: string }): Promise<org_agent_migrations> {
    return this.migrationService.getMigration(payload.orgId);
  }

  @MessagePattern({ cmd: 'list-org-agent-migrations' })
  async listMigrations(
    payload: IListOrgAgentMigrations
  ): Promise<{ total: number; migrations: org_agent_migrations[] }> {
    return this.migrationService.listMigrations(payload);
  }
}
