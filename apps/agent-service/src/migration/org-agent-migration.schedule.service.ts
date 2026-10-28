/* eslint-disable camelcase */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';
import { ResponseMessages } from '@credebl/common/response-messages';
import { org_agent_migrations } from '@prisma/client';
import { REHEARSAL_DONE, OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { envMs } from './migration-job-poller';
import { IScheduleOrgAgentMigration } from './org-agent-migration.interface';
import { OrgAgentMigrationService } from './org-agent-migration.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const DEFAULT_MAX_LEAD_DAYS = 14;

const maxLeadMs = (): number => envMs('ORG_MIGRATION_MAX_LEAD_DAYS', DEFAULT_MAX_LEAD_DAYS) * DAY_MS;

/**
 * The owner's commitment to move: after a finished rehearsal they type the organisation's name and pick a slot (or
 * start now). The move becomes SCHEDULED and the scheduler starts it when the slot arrives. Scheduling again before
 * then moves the slot.
 */
@Injectable()
export class OrgAgentMigrationScheduleService {
  constructor(
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly migrationService: OrgAgentMigrationService
  ) {}

  /**
   * @throws when there is no rehearsed migration, the typed name is wrong, or the slot is not allowed
   */
  async schedule(payload: IScheduleOrgAgentMigration): Promise<org_agent_migrations> {
    const { orgId, userId, confirmationName } = payload;

    const migration = await this.migrationRepository.getActiveByOrgId(orgId);
    if (!migration) {
      throw new NotFoundException(ResponseMessages.agent.error.migrationNotFound);
    }
    if (OrgAgentMigrationStatus.CREATED === migration.status || REHEARSAL_DONE !== migration.rehearsalStatus) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationNotRehearsed);
    }
    if (![OrgAgentMigrationStatus.REHEARSED, OrgAgentMigrationStatus.SCHEDULED].includes(migration.status as never)) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationInvalidTransition);
    }

    // Exact, as typed: the owner is confirming they know which organisation is moving.
    const orgName = await this.migrationRepository.getOrgName(orgId);
    if (!orgName || 'string' !== typeof confirmationName || confirmationName.trim() !== orgName.trim()) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationConfirmationMismatch);
    }

    const now = Date.now();
    const slot = this.slotFrom(payload.scheduledFor, now);

    return this.migrationService.advance(
      migration.id,
      OrgAgentMigrationStatus.SCHEDULED,
      userId,
      { scheduledFor: slot },
      {
        event: {
          action: 'MOVE_CONFIRMED',
          detail: { scheduledFor: slot.toISOString(), immediate: undefined === payload.scheduledFor }
        }
      }
    );
  }

  // No slot means now. A given slot must be in the future (a minute of clock skew allowed) and inside the window.
  private slotFrom(scheduledFor: string | Date | undefined, now: number): Date {
    if (undefined === scheduledFor || null === scheduledFor) {
      return new Date(now);
    }
    const slot = new Date(scheduledFor);
    if (Number.isNaN(slot.getTime()) || slot.getTime() < now - CLOCK_SKEW_MS || slot.getTime() > now + maxLeadMs()) {
      throw new BadRequestException(ResponseMessages.agent.error.migrationSlotInvalid);
    }
    return slot;
  }
}
