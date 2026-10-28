/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, no-mixed-operators, prefer-destructuring */
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  ...overrides
});

const build = (options: { migration?: object | null; orgName?: string | null } = {}) => {
  const migration = 'migration' in options ? options.migration : row();
  const migrationRepository = {
    getActiveByOrgId: jest.fn().mockResolvedValue(migration),
    getOrgName: jest.fn().mockResolvedValue('orgName' in options ? options.orgName : 'Acme Ltd'),
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
      { scheduledFor: slot },
      { event: { action: 'MOVE_CONFIRMED', detail: { scheduledFor: slot.toISOString(), immediate: false } } }
    );
    expect(migrationRepository.recordEvent).not.toHaveBeenCalled();
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
      const { service } = build();

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
