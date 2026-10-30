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
  const authorizer = { assertOwner: jest.fn().mockResolvedValue(undefined) };
  const alertService = { alertKeyExport: jest.fn().mockResolvedValue({ recipients: 2, sent: 2 }) };
  const migrationRepository = { recordEvent: jest.fn().mockResolvedValue(undefined) };
  const logger = { error: jest.fn() };
  const controller = new OrgAgentMigrationController(
    migrationService as never,
    preflightService as never,
    rehearsalService as never,
    authorizer as never,
    alertService as never,
    migrationRepository as never,
    logger as never
  );
  return {
    controller,
    migrationService,
    preflightService,
    rehearsalService,
    authorizer,
    alertService,
    migrationRepository,
    logger,
    report
  };
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
      expect(preflightService.run).toHaveBeenCalledWith('m1', payload, USER_ID);
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
      expect(preflightService.run).toHaveBeenCalledWith(
        'm1',
        { orgId: ORG_ID, userId: USER_ID, apiKey: 'new-key' },
        USER_ID
      );
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

  describe('owner-only access', () => {
    const denied = () => new RpcException('Only an owner of the organization can move its wallet');
    const payload = {
      orgId: ORG_ID,
      userId: USER_ID,
      targetAdminEndpoint: 'https://a.example.com',
      targetDidcommEndpoint: 'https://b.example.com'
    };

    it('checks the caller is an owner of the org before each action', async () => {
      const { controller, authorizer } = build();

      await controller.createMigration(payload);
      await controller.preflight({ orgId: ORG_ID, userId: USER_ID });
      await controller.rehearse({ orgId: ORG_ID, userId: USER_ID });

      expect(authorizer.assertOwner).toHaveBeenCalledTimes(3);
      expect(authorizer.assertOwner).toHaveBeenCalledWith(ORG_ID, USER_ID);
    });

    it('creates nothing for a non-owner', async () => {
      const { controller, authorizer, migrationService, alertService } = build();
      authorizer.assertOwner.mockRejectedValue(denied());

      await expect(controller.createMigration(payload)).rejects.toBeInstanceOf(RpcException);

      expect(migrationService.createMigration).not.toHaveBeenCalled();
      expect(alertService.alertKeyExport).not.toHaveBeenCalled();
    });

    it('runs no checks for a non-owner', async () => {
      const { controller, authorizer, preflightService } = build();
      authorizer.assertOwner.mockRejectedValue(denied());

      await expect(controller.preflight({ orgId: ORG_ID, userId: USER_ID })).rejects.toBeInstanceOf(RpcException);

      expect(preflightService.run).not.toHaveBeenCalled();
    });

    it('starts no rehearsal for a non-owner', async () => {
      const { controller, authorizer, rehearsalService } = build();
      authorizer.assertOwner.mockRejectedValue(denied());

      await expect(controller.rehearse({ orgId: ORG_ID, userId: USER_ID })).rejects.toBeInstanceOf(RpcException);

      expect(rehearsalService.start).not.toHaveBeenCalled();
    });
  });

  describe('the move-started alert', () => {
    const payload = {
      orgId: ORG_ID,
      userId: USER_ID,
      targetAdminEndpoint: 'https://a.example.com',
      targetDidcommEndpoint: 'https://b.example.com'
    };

    it('goes out when the migration is created and is audited', async () => {
      const { controller, alertService, migrationRepository } = build();

      await controller.createMigration(payload);

      expect(alertService.alertKeyExport).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm1' }),
        'MOVE_STARTED',
        USER_ID
      );
      expect(migrationRepository.recordEvent).toHaveBeenCalledWith('m1', {
        action: 'MOVE_STARTED_ALERT',
        actor: USER_ID,
        detail: { alertsSent: 2, recipients: 2 }
      });
    });

    it('does not stop the migration from being created when it cannot be sent', async () => {
      const { controller, alertService, preflightService } = build();
      alertService.alertKeyExport.mockRejectedValue(new Error('smtp down'));

      const result = await controller.createMigration(payload);

      expect(result.migration).toMatchObject({ id: 'm1' });
      expect(preflightService.run).toHaveBeenCalled();
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
