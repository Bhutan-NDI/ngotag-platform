/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { RpcException } from '@nestjs/microservices';
import { OrgAgentMigrationController } from './org-agent-migration.controller';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';
const SECRET = 'ENCRYPTED-ROOT-TOKEN';

const row = (overrides = {}) => ({
  id: 'm1',
  orgId: ORG_ID,
  status: 'CREATED',
  targetTokenEncrypted: SECRET,
  ...overrides
});

const build = () => {
  const migrationService = {
    createMigration: jest.fn().mockResolvedValue(row()),
    getMigration: jest.fn().mockResolvedValue(row()),
    listMigrations: jest.fn().mockResolvedValue({ total: 1, migrations: [row()] })
  };
  const report = { ranAt: 'now', passed: true, checks: [] };
  const preflightService = { run: jest.fn().mockResolvedValue({ migration: row({ id: 'm1' }), report }) };
  const rehearsalService = { start: jest.fn().mockResolvedValue(row({ rehearsalStatus: 'RUNNING' })) };
  const logger = { error: jest.fn() };
  const controller = new OrgAgentMigrationController(
    migrationService as never,
    preflightService as never,
    rehearsalService as never,
    logger as never
  );
  return { controller, migrationService, preflightService, rehearsalService, logger, report };
};

describe('OrgAgentMigrationController', () => {
  const handlers: [keyof OrgAgentMigrationController, string][] = [
    ['createMigration', 'migrate-org-agent'],
    ['preflight', 'preflight-org-agent-migration'],
    ['rehearse', 'rehearse-org-agent-migration'],
    ['getMigration', 'get-org-agent-migration'],
    ['listMigrations', 'list-org-agent-migrations']
  ];

  it.each(handlers)('%s is bound to the %s NATS subject', (method, cmd) => {
    const pattern = Reflect.getMetadata('microservices:pattern', OrgAgentMigrationController.prototype[method]);

    expect(pattern).toEqual([{ cmd }]);
  });

  describe('migrate-org-agent', () => {
    const payload = {
      orgId: ORG_ID,
      userId: USER_ID,
      targetAdminEndpoint: 'https://a.example.com',
      targetDidcommEndpoint: 'https://b.example.com',
      apiKey: 'key',
      backupsConfirmed: true
    };

    it('creates the migration, runs the first preflight with the key and the confirmation, and returns the report', async () => {
      const { controller, migrationService, preflightService, report } = build();

      const result = await controller.createMigration(payload);

      expect(migrationService.createMigration).toHaveBeenCalledWith(payload);
      expect(preflightService.run).toHaveBeenCalledWith('m1', payload);
      expect(result.preflight).toBe(report);
    });

    it('still returns the created migration when the preflight could not run', async () => {
      const { controller, preflightService, logger } = build();
      preflightService.run.mockRejectedValue(new Error('database down'));

      const result = await controller.createMigration(payload);

      expect(result.preflight).toBeNull();
      expect(result.migration).toMatchObject({ id: 'm1' });
      expect(logger.error).toHaveBeenCalled();
    });

    it('never returns the stored token', async () => {
      const { controller } = build();

      const result = await controller.createMigration(payload);

      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.migration).not.toHaveProperty('targetTokenEncrypted');
    });
  });

  describe('preflight-org-agent-migration', () => {
    it("re-runs the checks on the org's active migration", async () => {
      const { controller, migrationService, preflightService } = build();

      await controller.preflight({ orgId: ORG_ID, userId: USER_ID, apiKey: 'new-key' });

      expect(migrationService.getMigration).toHaveBeenCalledWith(ORG_ID);
      expect(preflightService.run).toHaveBeenCalledWith('m1', { orgId: ORG_ID, userId: USER_ID, apiKey: 'new-key' });
    });

    it('surfaces a failure as an RPC error', async () => {
      const { controller, preflightService } = build();
      preflightService.run.mockRejectedValue(new Error('nope'));

      await expect(controller.preflight({ orgId: ORG_ID, userId: USER_ID })).rejects.toBeInstanceOf(RpcException);
    });
  });

  describe('rehearse-org-agent-migration', () => {
    it('starts the rehearsal as the caller and hides the token', async () => {
      const { controller, rehearsalService } = build();

      const result = await controller.rehearse({ orgId: ORG_ID, userId: USER_ID });

      expect(rehearsalService.start).toHaveBeenCalledWith(ORG_ID, USER_ID);
      expect(result).toMatchObject({ rehearsalStatus: 'RUNNING' });
      expect(result).not.toHaveProperty('targetTokenEncrypted');
    });

    it('surfaces a refusal as an RPC error', async () => {
      const { controller, rehearsalService } = build();
      rehearsalService.start.mockRejectedValue(new Error('already running'));

      await expect(controller.rehearse({ orgId: ORG_ID, userId: USER_ID })).rejects.toBeInstanceOf(RpcException);
    });
  });

  describe('reading migrations', () => {
    it('hides the stored token from a single read and from a list', async () => {
      const { controller } = build();

      const single = await controller.getMigration({ orgId: ORG_ID });
      const listed = await controller.listMigrations({ orgId: ORG_ID });

      expect(JSON.stringify([single, listed])).not.toContain(SECRET);
      expect(listed.total).toBe(1);
    });
  });
});
