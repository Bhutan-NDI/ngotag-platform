/* eslint-disable camelcase */
import { Injectable } from '@nestjs/common';
import { org_agent_migrations } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { IAgentAccess } from './migration-agent-access';
import { MigrationAgentClient, MigrationAgentError } from './migration-agent.client';

const PROBE_TTL_MS = 5 * 60 * 1000;

// `code` says why, when it was not confirmed.
export interface WebhookCheckResult {
  confirmed: boolean;
  code?: string;
}

export const hashProbeId = (probeId: string): string => createHash('sha256').update(probeId).digest('hex');

/**
 * Whether the dedicated agent's webhook URL reaches this platform for this organisation. The agent cannot be asked for
 * its URL and never learns whether a webhook arrived, so the platform makes a one-time probe id, has the agent post it
 * to its own webhook URL, and trusts only its own record of the probe arriving.
 */
@Injectable()
export class OrgAgentMigrationWebhookService {
  constructor(
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly agentClient: MigrationAgentClient
  ) {}

  async check(migration: org_agent_migrations, agent: IAgentAccess): Promise<WebhookCheckResult> {
    const probeId = randomUUID();
    const probeHash = hashProbeId(probeId);
    if (!(await this.migrationRepository.tryBeginWebhookProbe(migration.id, probeHash, this.expiry()))) {
      return { confirmed: false, code: 'WEBHOOK_CHECK_BUSY' };
    }

    try {
      const sent = await this.agentClient.probeWebhook(agent.endpoint, agent.token, probeId);
      const row = await this.migrationRepository.getById(migration.id);
      if (row && null === row.webhookProbeHash) {
        return { confirmed: true };
      }
      if (!sent.configured) {
        return { confirmed: false, code: 'WEBHOOK_NOT_CONFIGURED' };
      }
      return { confirmed: false, code: sent.delivered ? 'WEBHOOK_REJECTED' : 'WEBHOOK_UNREACHABLE' };
    } catch (error) {
      // An agent that lacks the probe route has an older release, which the release check reports.
      const unsupported = error instanceof MigrationAgentError && 'NOT_FOUND' === error.kind;
      return { confirmed: false, code: unsupported ? 'WEBHOOK_PROBE_UNSUPPORTED' : 'AGENT_UNAVAILABLE' };
    } finally {
      await this.migrationRepository.endWebhookProbe(migration.id, probeHash).catch(() => undefined);
    }
  }

  /**
   * The platform end of the probe: the dedicated agent posted `probeId` to `/wh/<orgId>/probe`.
   * @returns whether it was the live probe of that organisation's unfinished migration
   */
  confirm(orgId: string, probeId: string): Promise<boolean> {
    return this.migrationRepository.confirmWebhookProbe(orgId, hashProbeId(probeId));
  }

  private expiry(): Date {
    return new Date(Date.now() + PROBE_TTL_MS);
  }
}
