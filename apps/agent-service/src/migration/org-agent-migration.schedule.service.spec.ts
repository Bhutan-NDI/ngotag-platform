/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, no-mixed-operators, prefer-destructuring */
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { OrgAgentMigrationScheduleService } from './org-agent-migration.schedule.service';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const row = (overrides = {}) => ({
  id: 'm1',
  orgId: ORG_ID,
  status: Status.REHEARSED,
  rehearsalStatus: 'DONE',
  rehearsal: { finishedAt: new Date(Date.now() - HOUR).toISOString() },
  ...overrides
});

const build = (options: { migration?: object | null; orgName?: string | null } = {}) => {
  const migration = 'migration' in options ? options.migration : row();
  const migrationRepository = {
    getActiveByOrgId: jest.fn().mockResolvedValue(migration),
    getOrgName: jest.fn().mockResolvedValue('orgName' in options ? options.orgName : 'Acme Ltd'),
    hasActiveBulkIssuance: jest.fn().mockResolvedValue(false),
    recordEvent: jest.fn().mockResolvedValue(undefined)
  };
  const migrationService = { advance: jest.fn().mockResolvedValue({ id: 'm1', status: Status.SCHEDULED }) };
  const service = new OrgAgentMigrationScheduleService(migrationRepository as never, migrationService as never);
  return { service, migrationRepository, migrationService };
};

const schedule = (service: OrgAgentMigrationScheduleService, overrides = {}) =>
  service.schedule({ orgId: ORG_ID, userId: USER_ID, confirmationName: 'Acme Ltd', ...overrides });

afterEach(() => {
  delete process.env.ORG_MIGRATION_MAX_LEAD_DAYS;
  delete process.env.ORG_MIGRATION_REHEARSAL_MAX_AGE_DAYS;
});

describe('OrgAgentMigrationScheduleService.schedule', () => {
  it('books the slot the owner picked, as that owner, and records the confirmation', async () => {
    const { service, migrationService, migrationRepository } = build();
    const slot = new Date(Date.now() + 3 * DAY);

    await schedule(service, { scheduledFor: slot.toISOString() });

    expect(migrationService.advance).toHaveBeenCalledWith(
      'm1',
      Status.SCHEDULED,
      USER_ID,
      { scheduledFor: slot, error: null },
      {
        expectedFrom: Status.REHEARSED,
        event: { action: 'MOVE_CONFIRMED', detail: { scheduledFor: slot.toISOString(), immediate: false } }
      }
    );
    expect(migrationRepository.recordEvent).not.toHaveBeenCalled();
  });

  it('clears the reason an earlier slot was lost, when the owner schedules again', async () => {
    const { service, migrationService } = build({ migration: row({ error: 'SLOT_MISSED', scheduledFor: null }) });

    await schedule(service, { scheduledFor: new Date(Date.now() + DAY).toISOString() });

    expect(migrationService.advance.mock.calls[0][3]).toMatchObject({ error: null });
  });

  describe('a bulk issuance that is still running', () => {
    it('refuses to confirm with 409 ORG_BULK_JOB_ACTIVE, and books nothing', async () => {
      const { service, migrationRepository, migrationService } = build();
      migrationRepository.hasActiveBulkIssuance.mockResolvedValue(true);

      const error = await schedule(service).catch((e) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ statusCode: 409, error: 'ORG_BULK_JOB_ACTIVE' });
      expect(migrationService.advance).not.toHaveBeenCalled();
      expect(migrationRepository.recordEvent).not.toHaveBeenCalled();
      expect(migrationRepository.hasActiveBulkIssuance).toHaveBeenCalledWith(ORG_ID);
    });

    it('lets an owner who has booked a slot move it while a job runs, without a second check', async () => {
      const { service, migrationRepository, migrationService } = build({
        migration: row({ scheduledFor: new Date(Date.now() + DAY) })
      });
      migrationRepository.hasActiveBulkIssuance.mockResolvedValue(true);

      await expect(
        schedule(service, { scheduledFor: new Date(Date.now() + 2 * DAY).toISOString() })
      ).resolves.toBeDefined();

      expect(migrationService.advance).toHaveBeenCalled();
      expect(migrationRepository.hasActiveBulkIssuance).not.toHaveBeenCalled();
    });

    it('confirms when none is running', async () => {
      const { service, migrationService } = build();

      await expect(schedule(service)).resolves.toBeDefined();
      expect(migrationService.advance).toHaveBeenCalled();
    });

    it('still checks the name first, so the answer does not tell a stranger what is running', async () => {
      const { service, migrationRepository } = build();
      migrationRepository.hasActiveBulkIssuance.mockResolvedValue(true);

      await expect(schedule(service, { confirmationName: 'Someone else' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('the age of the rehearsal', () => {
    it.each([
      ['a day old', DAY, true],
      ['thirteen days old', 13 * DAY, true],
      ['fifteen days old', 15 * DAY, false]
    ])('is %s: allowed is %s', async (_name, age, allowed) => {
      const { service, migrationService } = build({
        migration: row({ rehearsal: { finishedAt: new Date(Date.now() - age).toISOString() } })
      });

      const result = schedule(service);

      if (allowed) {
        await expect(result).resolves.toBeDefined();
        expect(migrationService.advance).toHaveBeenCalled();
      } else {
        await expect(result).rejects.toBeInstanceOf(BadRequestException);
        expect(migrationService.advance).not.toHaveBeenCalled();
      }
    });

    it('cannot be used for a move when the rehearsal has no finish time on record', async () => {
      const { service } = build({ migration: row({ rehearsal: null }) });

      await expect(schedule(service)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets a fresh rehearsal book any day of the 14-day picker', async () => {
      const { service } = build();

      await expect(
        schedule(service, { scheduledFor: new Date(Date.now() + 10 * DAY).toISOString() })
      ).resolves.toBeDefined();
    });

    it('refuses a slot the rehearsal will be too old for, even though it is not too old now', async () => {
      const { service, migrationService } = build({
        migration: row({ rehearsal: { finishedAt: new Date(Date.now() - 10 * DAY).toISOString() } })
      });

      await expect(
        schedule(service, { scheduledFor: new Date(Date.now() + 5 * DAY).toISOString() })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(migrationService.advance).not.toHaveBeenCalled();
    });

    it('accepts a slot still inside the rehearsal limit', async () => {
      const { service } = build({
        migration: row({ rehearsal: { finishedAt: new Date(Date.now() - 10 * DAY).toISOString() } })
      });

      await expect(
        schedule(service, { scheduledFor: new Date(Date.now() + 3 * DAY).toISOString() })
      ).resolves.toBeDefined();
    });

    it('reads the limit from the environment', async () => {
      process.env.ORG_MIGRATION_REHEARSAL_MAX_AGE_DAYS = '30';
      const { service } = build({
        migration: row({ rehearsal: { finishedAt: new Date(Date.now() - 20 * DAY).toISOString() } })
      });

      await expect(schedule(service)).resolves.toBeDefined();
    });
  });

  it('starts at once when no slot is given', async () => {
    const { service, migrationService } = build();
    const before = Date.now();

    await schedule(service);

    const [, , , patch, options] = migrationService.advance.mock.calls[0];
    expect(patch.scheduledFor.getTime()).toBeGreaterThanOrEqual(before);
    expect(patch.scheduledFor.getTime()).toBeLessThan(before + 5000);
    expect(options.event.detail.immediate).toBe(true);
  });

  it('lets the owner move the slot by scheduling again', async () => {
    const { service, migrationService } = build({
      migration: row({ status: Status.SCHEDULED, scheduledFor: new Date(Date.now() + DAY) })
    });

    await schedule(service, { scheduledFor: new Date(Date.now() + 2 * DAY).toISOString() });

    expect(migrationService.advance).toHaveBeenCalledTimes(1);
  });

  describe('the typed name', () => {
    it.each(['acme ltd', 'Acme Limited', '', 'Acme  Ltd'])('refuses "%s"', async (typed) => {
      const { service, migrationService } = build();

      await expect(schedule(service, { confirmationName: typed })).rejects.toBeInstanceOf(BadRequestException);

      expect(migrationService.advance).not.toHaveBeenCalled();
    });

    it('ignores spaces around it', async () => {
      const { service, migrationService } = build();

      await schedule(service, { confirmationName: '  Acme Ltd ' });

      expect(migrationService.advance).toHaveBeenCalled();
    });

    it('refuses when nothing was typed', async () => {
      const { service } = build();

      await expect(schedule(service, { confirmationName: undefined })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not reveal the name in the refusal', async () => {
      const { service } = build();

      const error = await schedule(service, { confirmationName: 'nope' }).catch((e) => e);

      expect(JSON.stringify(error.getResponse())).not.toContain('Acme');
    });

    it('refuses when the org has no readable name', async () => {
      const { service } = build({ orgName: null });

      await expect(schedule(service)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('the slot', () => {
    it.each([
      ['in the past', new Date(Date.now() - HOUR).toISOString()],
      ['not a date', 'next tuesday'],
      ['beyond 14 days', new Date(Date.now() + 15 * DAY).toISOString()]
    ])('refuses a slot %s', async (_name, scheduledFor) => {
      const { service, migrationService } = build();

      await expect(schedule(service, { scheduledFor })).rejects.toBeInstanceOf(BadRequestException);

      expect(migrationService.advance).not.toHaveBeenCalled();
    });

    it('accepts a slot a few seconds in the past, for clock skew', async () => {
      const { service } = build();

      await expect(schedule(service, { scheduledFor: new Date(Date.now() - 5000) })).resolves.toBeDefined();
    });

    it('accepts the far edge of the window', async () => {
      const { service } = build({ migration: row({ rehearsal: { finishedAt: new Date().toISOString() } }) });

      await expect(schedule(service, { scheduledFor: new Date(Date.now() + 14 * DAY - 1000) })).resolves.toBeDefined();
    });

    it('reads the window from the environment', async () => {
      process.env.ORG_MIGRATION_MAX_LEAD_DAYS = '3';
      const { service } = build();

      await expect(schedule(service, { scheduledFor: new Date(Date.now() + 4 * DAY) })).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(schedule(service, { scheduledFor: new Date(Date.now() + 2 * DAY) })).resolves.toBeDefined();
    });
  });

  describe('when the move is not ready', () => {
    it('refuses before any rehearsal', async () => {
      const { service } = build({ migration: row({ status: Status.CREATED, rehearsalStatus: null }) });

      await expect(schedule(service)).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['a rehearsal is running again', { rehearsalStatus: 'RUNNING' }],
      ['the last rehearsal failed', { rehearsalStatus: 'FAILED' }]
    ])('refuses when %s', async (_name, overrides) => {
      const { service, migrationService } = build({ migration: row(overrides) });

      await expect(schedule(service, { scheduledFor: new Date(Date.now() + DAY) })).rejects.toBeInstanceOf(
        BadRequestException
      );

      expect(migrationService.advance).not.toHaveBeenCalled();
    });

    it.each([Status.FROZEN, Status.EXPORTING, Status.CUTOVER, Status.STABILISING, Status.FAILED])(
      'refuses a move that is in %s',
      async (status) => {
        const { service } = build({ migration: row({ status }) });

        await expect(schedule(service)).rejects.toBeInstanceOf(BadRequestException);
      }
    );

    it('refuses when the org has no active migration', async () => {
      const { service } = build({ migration: null });

      await expect(schedule(service)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
