/* eslint-disable camelcase */
import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '@credebl/common/email.service';
import { EmailDto } from '@credebl/common/dtos/email.dto';
import { CommonConstants } from '@credebl/common/common.constant';
import { escapeHtml } from '@credebl/common/common.utils';
import { org_agent_migrations } from '@prisma/client';
import { AgentServiceRepository } from '../repositories/agent-service.repository';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';

export enum KeyExportAlertKind {
  MOVE_STARTED = 'MOVE_STARTED',
  REHEARSAL_EXPORT = 'REHEARSAL_EXPORT',
  MOVE_EXPORT = 'MOVE_EXPORT',
  DISASTER_RESTORE = 'DISASTER_RESTORE'
}

export interface IKeyExportAlertResult {
  recipients: number;
  sent: number;
}

interface IAlertDescription {
  subject: string;
  what: string;
  who?: string;
  targetLabel?: string;
}

const DESCRIPTIONS: Record<KeyExportAlertKind, IAlertDescription> = {
  [KeyExportAlertKind.MOVE_STARTED]: {
    subject: 'A wallet move was started',
    what: 'started a move of the organisation’s wallet to its own agent'
  },
  [KeyExportAlertKind.MOVE_EXPORT]: {
    subject: 'The organisation’s signing keys were exported for the move',
    what: 'exported the organisation’s wallet, including its signing keys, to move it to its own agent'
  },
  [KeyExportAlertKind.REHEARSAL_EXPORT]: {
    subject: 'The organisation’s signing keys were exported for a rehearsal',
    what: 'exported the organisation’s wallet, including its signing keys, for a rehearsal of the move'
  },
  [KeyExportAlertKind.DISASTER_RESTORE]: {
    subject: 'A wallet move was rolled back',
    who: 'A platform admin',
    what: 'rolled the organisation’s move back to the shared agent after its new agent was lost; what the new agent did since the switch is lost',
    targetLabel: 'The agent that was lost'
  }
};

// The host only: enough to spot an export going somewhere unexpected, without printing the full address.
const hostOf = (address: string): string => {
  try {
    return new URL(address).host;
  } catch {
    return 'an unreadable address';
  }
};

/**
 * Tells the people who would notice misuse that an organisation's keys are being handed over: the org's owners and
 * the platform admin team (ADR-WM-008). The alert is the compensating control for owner-run moves, so it names who
 * did it, for which org, and where the keys are going.
 */
@Injectable()
export class OrgAgentMigrationAlertService {
  constructor(
    private readonly agentServiceRepository: AgentServiceRepository,
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly emailService: EmailService,
    private readonly logger: Logger
  ) {}

  /** Sends one email per recipient, so one bad address cannot hide the alert from the others. */
  async alertKeyExport(
    migration: org_agent_migrations,
    kind: KeyExportAlertKind,
    actorUserId: string
  ): Promise<IKeyExportAlertResult> {
    const [recipients, orgName, actorEmail, platformConfig] = await Promise.all([
      this.migrationRepository.getExportAlertRecipients(migration.orgId, CommonConstants.PLATFORM_ADMIN_ORG),
      this.migrationRepository.getOrgName(migration.orgId),
      this.migrationRepository.getUserEmail(actorUserId),
      this.agentServiceRepository.getPlatformConfigDetails()
    ]);

    if (0 === recipients.length || !platformConfig?.emailFrom) {
      return { recipients: recipients.length, sent: 0 };
    }

    const description = DESCRIPTIONS[kind];
    const { subject } = description;
    const results = await Promise.allSettled(
      recipients.map((recipient) => {
        const email = new EmailDto();
        email.emailFrom = platformConfig.emailFrom;
        email.emailTo = recipient;
        email.emailSubject = `[Security] ${subject}`;
        email.emailText = this.text(description, orgName, actorEmail, migration);
        email.emailHtml = this.html(description, orgName, actorEmail, migration);
        return this.emailService.sendEmail(email);
      })
    );

    const sent = results.filter((result) => 'fulfilled' === result.status && result.value).length;
    if (sent < recipients.length) {
      this.logger.error(
        `[alertKeyExport] ${migration.id}: ${recipients.length - sent} of ${recipients.length} alerts failed`
      );
    }
    return { recipients: recipients.length, sent };
  }

  private facts(
    description: IAlertDescription,
    orgName: string | null,
    actorEmail: string | null,
    migration: org_agent_migrations
  ): [string, string][] {
    return [
      ['Organisation', orgName ?? migration.orgId],
      ['Done by', actorEmail ?? 'an unknown user'],
      [description.targetLabel ?? 'Keys are going to', hostOf(migration.targetAdminEndpoint)],
      ['Time', new Date().toISOString()]
    ];
  }

  private text(
    description: IAlertDescription,
    orgName: string | null,
    actorEmail: string | null,
    migration: org_agent_migrations
  ): string {
    const lines = this.facts(description, orgName, actorEmail, migration).map(([label, value]) => `${label}: ${value}`);
    return [
      `${description.who ?? 'An organisation owner'} ${description.what}.`,
      '',
      ...lines,
      '',
      'If you did not expect this, contact the security team now.'
    ].join('\n');
  }

  private html(
    description: IAlertDescription,
    orgName: string | null,
    actorEmail: string | null,
    migration: org_agent_migrations
  ): string {
    const rows = this.facts(description, orgName, actorEmail, migration)
      .map(([label, value]) => `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(value)}</td></tr>`)
      .join('');
    return `<p>${escapeHtml(description.who ?? 'An organisation owner')} ${escapeHtml(description.what)}.</p><table>${rows}</table><p>If you did not expect this, contact the security team now.</p>`;
  }
}
