/* eslint-disable camelcase */
import { Injectable } from '@nestjs/common';
import { CommonService } from '@credebl/common';
import { CommonConstants } from '@credebl/common/common.constant';
import { org_agent_migrations } from '@prisma/client';
import { AgentServiceRepository } from '../repositories/agent-service.repository';

export interface IAgentAccess {
  endpoint: string;
  token: string;
}

/**
 * Where the migration gets its credentials. The orchestrator never goes through getOrgAgentApiKey, so a frozen org
 * cannot lock it out: it calls the shared agent with the base-wallet token and the dedicated agent with the root
 * token it stored at preflight.
 */
@Injectable()
export class MigrationAgentAccess {
  constructor(
    private readonly agentServiceRepository: AgentServiceRepository,
    private readonly commonService: CommonService
  ) {}

  async shared(): Promise<IAgentAccess | undefined> {
    try {
      const admin = await this.agentServiceRepository.platformAdminAgent(CommonConstants.PLATFORM_ADMIN_ORG);
      const row = admin?.org_agents?.[0];
      if (!row?.agentEndPoint || !row.apiKey) {
        return undefined;
      }
      return { endpoint: row.agentEndPoint, token: await this.commonService.decryptPassword(row.apiKey) };
    } catch {
      return undefined;
    }
  }

  async dedicated(migration: org_agent_migrations): Promise<IAgentAccess | undefined> {
    if (!migration.targetTokenEncrypted) {
      return undefined;
    }
    return {
      endpoint: migration.targetAdminEndpoint,
      token: await this.commonService.decryptPassword(migration.targetTokenEncrypted)
    };
  }

  encryptToken(token: string): string {
    return this.commonService.dataEncryption(token);
  }
}
