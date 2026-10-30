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

/** Things the platform does or finds on its own during a move, which the same people should hear about once. */
export enum MigrationNoticeKind {
  PURGE_FAILING = 'PURGE_FAILING',
  WEBHOOK_DEFERRED = 'WEBHOOK_DEFERRED',
  WEBHOOK_GOING_AHEAD = 'WEBHOOK_GOING_AHEAD'
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

const NOTICES: Record<MigrationNoticeKind, { subject: string; what: string }> = {
  [MigrationNoticeKind.PURGE_FAILING]: {
    subject: 'A wallet move cannot finish removing the old wallet',
    what: 'The shared agent keeps failing to remove the organisation’s old wallet after its move, so the move cannot finish. The platform keeps retrying, more slowly.'
  },
  [MigrationNoticeKind.WEBHOOK_DEFERRED]: {
    subject: 'A wallet move is waiting for the new agent’s webhook',
    what: 'The new agent’s webhook does not reach the platform, so the old wallet is being kept for now. The switch-over waits a limited time for it to be fixed.'
  },
  [MigrationNoticeKind.WEBHOOK_GOING_AHEAD]: {
    subject: 'A wallet move went ahead with its webhook unconfirmed',
    what: 'The waiting time ran out with the new agent’s webhook still unconfirmed, so the old wallet was removed and the move went ahead.'
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
    return this.send(
      recipients,
      platformConfig.emailFrom,
      `[Security] ${description.subject}`,
      {
        text: this.text(description, orgName, actorEmail, migration),
        html: this.html(description, orgName, actorEmail, migration)
      },
      migration.id
    );
  }

  /** Tells the same people about something the platform did or found on its own, with no user involved. */
  async notify(migration: org_agent_migrations, kind: MigrationNoticeKind): Promise<IKeyExportAlertResult> {
    const [recipients, orgName, platformConfig] = await Promise.all([
      this.migrationRepository.getExportAlertRecipients(migration.orgId, CommonConstants.PLATFORM_ADMIN_ORG),
      this.migrationRepository.getOrgName(migration.orgId),
      this.agentServiceRepository.getPlatformConfigDetails()
    ]);
    if (0 === recipients.length || !platformConfig?.emailFrom) {
      return { recipients: recipients.length, sent: 0 };
    }

    const { subject, what } = NOTICES[kind];
    const name = orgName ?? migration.orgId;
    return this.send(
      recipients,
      platformConfig.emailFrom,
      `[Wallet move] ${subject}`,
      {
        text: `${what}\n\nOrganisation: ${name}\nTime: ${new Date().toISOString()}`,
        html: `<p>${escapeHtml(what)}</p><table><tr><td><strong>Organisation</strong></td><td>${escapeHtml(name)}</td></tr></table>`
      },
      migration.id
    );
  }

  private async send(
    recipients: string[],
    emailFrom: string,
    subject: string,
    body: { text: string; html: string },
    migrationId: string
  ): Promise<IKeyExportAlertResult> {
    const results = await Promise.allSettled(
      recipients.map((recipient) => {
        const email = new EmailDto();
        email.emailFrom = emailFrom;
        email.emailTo = recipient;
        email.emailSubject = subject;
        email.emailText = body.text;
        email.emailHtml = body.html;
        return this.emailService.sendEmail(email);
      })
    );

    const sent = results.filter((result) => 'fulfilled' === result.status && result.value).length;
    if (sent < recipients.length) {
      this.logger.error(`[alert] ${migrationId}: ${recipients.length - sent} of ${recipients.length} alerts failed`);
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
