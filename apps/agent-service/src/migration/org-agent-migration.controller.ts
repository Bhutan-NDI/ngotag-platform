/* eslint-disable camelcase */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, RpcException } from '@nestjs/microservices';
import { org_agent_migrations } from '@prisma/client';
import { OrgAgentMigrationService } from './org-agent-migration.service';
import { OrgAgentMigrationPreflightService } from './org-agent-migration.preflight.service';
import { OrgAgentMigrationRehearsalService } from './org-agent-migration.rehearsal.service';
import { OrgAgentMigrationAuthorizer } from './org-agent-migration.authorizer';
import { OrgAgentMigrationScheduleService } from './org-agent-migration.schedule.service';
import { KeyExportAlertKind, OrgAgentMigrationAlertService } from './org-agent-migration.alert.service';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import {
  ICancelOrgAgentMigration,
  ICreateOrgAgentMigration,
  IListOrgAgentMigrations,
  IOrgAgentMigration,
  IPreflightOrgAgentMigration,
  IPreflightReport,
  IRehearseOrgAgentMigration,
  IStartOrgAgentMigration,
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
    private readonly scheduleService: OrgAgentMigrationScheduleService,
    private readonly authorizer: OrgAgentMigrationAuthorizer,
    private readonly alertService: OrgAgentMigrationAlertService,
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly logger: Logger
  ) {}

  // Creates the migration, tells the alert recipients a move has started, and runs the first preflight so the owner
  // sees the checks as soon as it exists.
  @MessagePattern({ cmd: 'migrate-org-agent' })
  async createMigration(
    payload: ICreateOrgAgentMigration
  ): Promise<{ migration: IOrgAgentMigration; preflight: IPreflightReport | null }> {
    try {
      await this.authorizer.assertOwner(payload.orgId, payload.userId);
    } catch (error) {
      throw new RpcException(error.response ?? error);
    }

    const created = await this.migrationService.createMigration(payload);
    await this.announceMove(created, payload.userId);
    try {
      const { migration, report } = await this.preflightService.run(created.id, payload, payload.userId);
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
      await this.authorizer.assertOwner(payload.orgId, payload.userId);
      const active = await this.migrationService.getMigration(payload.orgId);
      const { migration, report } = await this.preflightService.run(active.id, payload, payload.userId);
      return { migration: toPublicMigration(migration), preflight: report };
    } catch (error) {
      throw error instanceof RpcException ? error : new RpcException(error.response ?? error);
    }
  }

  @MessagePattern({ cmd: 'rehearse-org-agent-migration' })
  async rehearse(payload: IRehearseOrgAgentMigration): Promise<IOrgAgentMigration> {
    try {
      await this.authorizer.assertOwner(payload.orgId, payload.userId);
      return toPublicMigration(await this.rehearsalService.start(payload.orgId, payload.userId));
    } catch (error) {
      throw new RpcException(error.response ?? error);
    }
  }

  // The owner's commitment: the typed org name and a slot. The scheduler starts the move when the slot arrives.
  @MessagePattern({ cmd: 'start-org-agent-migration' })
  async start(payload: IStartOrgAgentMigration): Promise<IOrgAgentMigration> {
    try {
      await this.authorizer.assertOwner(payload.orgId, payload.userId);
      return toPublicMigration(await this.scheduleService.confirm(payload));
    } catch (error) {
      throw new RpcException(error.response ?? error);
    }
  }

  // The owner calls the move off before it starts. The org stays exactly as it was.
  @MessagePattern({ cmd: 'cancel-org-agent-migration' })
  async cancel(payload: ICancelOrgAgentMigration): Promise<IOrgAgentMigration> {
    try {
      await this.authorizer.assertOwner(payload.orgId, payload.userId);
      return toPublicMigration(await this.migrationService.cancel(payload.orgId, payload.userId));
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

  // Best effort: the alert that gates each export is the one that matters, and it fails closed there.
  private async announceMove(migration: org_agent_migrations, actor: string): Promise<void> {
    try {
      const alert = await this.alertService.alertKeyExport(migration, KeyExportAlertKind.MOVE_STARTED, actor);
      await this.migrationRepository.recordEvent(migration.id, {
        action: 'MOVE_STARTED_ALERT',
        actor,
        detail: { alertsSent: alert.sent, recipients: alert.recipients }
      });
    } catch (error) {
      this.logger.error(`[migrate-org-agent] alert failed: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }
}
