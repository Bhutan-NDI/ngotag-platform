import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { NATSClient } from '@credebl/common/NATSClient';
import { BaseService } from 'libs/service/base.service';
import {
  CreateOrgAgentMigrationDto,
  ListOrgAgentMigrationsDto,
  PreflightOrgAgentMigrationDto,
  ScheduleOrgAgentMigrationDto
} from './dto/org-agent-migration.dto';

/**
 * Passes the owner's wallet-move requests on to agent-service. The org comes from the path and the user from the
 * verified token, so neither can be set from a request body. The payloads carry the agent API key, so they are
 * never logged here.
 */
@Injectable()
export class OrgAgentMigrationService extends BaseService {
  constructor(
    @Inject('NATS_CLIENT') private readonly agentServiceProxy: ClientProxy,
    private readonly natsClient: NATSClient
  ) {
    super('OrgAgentMigrationService');
  }

  create(orgId: string, userId: string, dto: CreateOrgAgentMigrationDto): Promise<object> {
    return this.natsClient.sendNatsMessage(this.agentServiceProxy, 'migrate-org-agent', {
      orgId,
      userId,
      targetAdminEndpoint: dto.targetAdminEndpoint,
      targetDidcommEndpoint: dto.targetDidcommEndpoint,
      apiKey: dto.apiKey,
      backupsConfirmed: dto.backupsConfirmed
    });
  }

  preflight(orgId: string, userId: string, dto: PreflightOrgAgentMigrationDto): Promise<object> {
    return this.natsClient.sendNatsMessage(this.agentServiceProxy, 'preflight-org-agent-migration', {
      orgId,
      userId,
      apiKey: dto.apiKey,
      backupsConfirmed: dto.backupsConfirmed
    });
  }

  rehearse(orgId: string, userId: string): Promise<object> {
    return this.natsClient.sendNatsMessage(this.agentServiceProxy, 'rehearse-org-agent-migration', { orgId, userId });
  }

  schedule(orgId: string, userId: string, dto: ScheduleOrgAgentMigrationDto): Promise<object> {
    return this.natsClient.sendNatsMessage(this.agentServiceProxy, 'schedule-org-agent-migration', {
      orgId,
      userId,
      confirmationName: dto.confirmationName,
      scheduledFor: dto.scheduledFor
    });
  }

  get(orgId: string): Promise<object> {
    return this.natsClient.sendNatsMessage(this.agentServiceProxy, 'get-org-agent-migration', { orgId });
  }

  list(query: ListOrgAgentMigrationsDto): Promise<object> {
    return this.natsClient.sendNatsMessage(this.agentServiceProxy, 'list-org-agent-migrations', {
      orgId: query.targetOrgId,
      status: query.status,
      pageNumber: query.pageNumber,
      pageSize: query.pageSize
    });
  }
}
