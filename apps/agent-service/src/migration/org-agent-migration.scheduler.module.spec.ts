/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
/**
 * The scheduler inside a real Nest module with the real ScheduleModule: its dependencies resolve, the interval is
 * registered at start-up, and it is gone again when the module closes.
 */
import { Logger } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';
import { OrgAgentMigrationExecutor } from './org-agent-migration.executor.service';
import { OrgAgentMigrationPreflightService } from './org-agent-migration.preflight.service';
import { OrgAgentMigrationScheduler } from './org-agent-migration.scheduler';
import { OrgAgentMigrationService } from './org-agent-migration.service';
import { OrgAgentMigrationSwitchOverService } from './org-agent-migration.switch-over.service';

const compile = async (repository: Record<string, jest.Mock> = {}) =>
  Test.createTestingModule({
    imports: [ScheduleModule.forRoot()],
    providers: [
      OrgAgentMigrationScheduler,
      {
        provide: OrgAgentMigrationRepository,
        useValue: {
          findStalled: jest.fn().mockResolvedValue([]),
          findDueForStart: jest.fn().mockResolvedValue([]),
          ...repository
        }
      },
      { provide: OrgAgentMigrationService, useValue: {} },
      { provide: OrgAgentMigrationPreflightService, useValue: {} },
      { provide: OrgAgentMigrationExecutor, useValue: {} },
      { provide: OrgAgentMigrationSwitchOverService, useValue: {} },
      { provide: Logger, useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }
    ]
  }).compile();

afterEach(() => {
  delete process.env.ORG_MIGRATION_SCHEDULER_ENABLED;
  delete process.env.ORG_MIGRATION_TICK_MS;
});

describe('OrgAgentMigrationScheduler in a Nest module', () => {
  it('registers its interval at start-up and removes it on close', async () => {
    process.env.ORG_MIGRATION_TICK_MS = '3600000';
    const moduleRef = await compile();
    const registry = moduleRef.get(SchedulerRegistry);

    await moduleRef.init();
    expect(registry.getIntervals()).toContain('org-agent-migration-tick');

    await moduleRef.close();
    expect(registry.getIntervals()).not.toContain('org-agent-migration-tick');
  });

  it('registers nothing when it is switched off', async () => {
    process.env.ORG_MIGRATION_SCHEDULER_ENABLED = 'false';
    const moduleRef = await compile();

    await moduleRef.init();

    expect(moduleRef.get(SchedulerRegistry).getIntervals()).toEqual([]);
    await moduleRef.close();
  });

  it('ticks on its own once started', async () => {
    process.env.ORG_MIGRATION_TICK_MS = '20';
    const findStalled = jest.fn().mockResolvedValue([]);
    const moduleRef = await compile({ findStalled });

    await moduleRef.init();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await moduleRef.close();

    expect(findStalled.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
