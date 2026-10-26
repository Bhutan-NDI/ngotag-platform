/**
 * Note this repo has no jest step in CI - run with:
 *   npx jest apps/agent-service/src/migration/org-agent-migration.service.spec.ts
 */
/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, implicit-arrow-linebreak */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { ResponseMessages } from '@credebl/common/response-messages';
import { OrgAgentMigrationService } from './org-agent-migration.service';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';
const MIGRATION_ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';

const sharedAgentRow = {
  orgAgentTypeId: 'shared-type-id',
  agentEndPoint: 'https://shared.example.com',
  tenantId: 'tenant-1',
  walletName: 'org-wallet',
  orgDid: 'did:polygon:abc',
  ledgerId: 'ledger-1',
  agentId: 'agent-1',
  agentsTypeId: 'agents-type-1',
  isDidPublic: true,
  apiKey: 'ENCRYPTED-TOKEN',
  webhookSecret: 'webhook-secret',
  agentOptions: Buffer.from('options')
};

const buildService = (options: { agent?: unknown; migration?: unknown; active?: unknown } = {}) => {
  const agentRepository = {
    getAgentDetailsByOrgId: jest.fn().mockResolvedValue('agent' in options ? options.agent : sharedAgentRow),
    getOrgAgentTypeDetails: jest.fn().mockResolvedValue('shared-type-id')
  };
  const migrationRepository = {
    create: jest.fn().mockResolvedValue({ id: MIGRATION_ID }),
    getById: jest
      .fn()
      .mockResolvedValue('migration' in options ? options.migration : { id: MIGRATION_ID, status: Status.CREATED }),
    getLatestByOrgId: jest.fn(),
    getActiveByOrgId: jest
      .fn()
      .mockResolvedValue('active' in options ? options.active : { id: MIGRATION_ID, status: Status.REHEARSED }),
    recordEvent: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ total: 0, migrations: [] }),
    transition: jest.fn().mockResolvedValue({ id: MIGRATION_ID })
  };
  const service = new OrgAgentMigrationService(
    agentRepository as never,
    migrationRepository as never,
    {
      error: jest.fn()
    } as never
  );
  return { service, agentRepository, migrationRepository };
};

const create = (service: OrgAgentMigrationService, overrides = {}) =>
  service.createMigration({
    orgId: ORG_ID,
    userId: USER_ID,
    targetAdminEndpoint: 'https://admin.example.com',
    targetDidcommEndpoint: 'https://didcomm.example.com',
    ...overrides
  });

const rpcError = (error: unknown): { statusCode?: number; message?: string } =>
  (error as RpcException).getError() as { statusCode?: number; message?: string };

describe('OrgAgentMigrationService', () => {
  describe('createMigration', () => {
    it('creates the migration with a snapshot of the shared agent that carries no secrets', async () => {
      const { service, migrationRepository } = buildService();

      await create(service);

      const [[call]] = migrationRepository.create.mock.calls;
      expect(call).toMatchObject({
        orgId: ORG_ID,
        startedBy: USER_ID,
        tenantId: 'tenant-1',
        targetAdminEndpoint: 'https://admin.example.com',
        targetDidcommEndpoint: 'https://didcomm.example.com'
      });
      expect(call.sourceOrgAgentSnapshot).toMatchObject({
        agentEndPoint: 'https://shared.example.com',
        orgDid: 'did:polygon:abc'
      });
      const serialised = JSON.stringify(call.sourceOrgAgentSnapshot);
      expect(serialised).not.toContain('ENCRYPTED-TOKEN');
      expect(serialised).not.toContain('webhook-secret');
      expect(Object.keys(call.sourceOrgAgentSnapshot)).not.toEqual(
        expect.arrayContaining(['apiKey', 'webhookSecret', 'agentOptions'])
      );
    });

    it.each([
      ['an http admin address', { targetAdminEndpoint: 'http://admin.example.com' }],
      ['an http DIDComm address', { targetDidcommEndpoint: 'http://didcomm.example.com' }],
      ['a malformed address', { targetAdminEndpoint: 'not a url' }],
      ['the same address for both', { targetDidcommEndpoint: 'https://admin.example.com/didcomm' }]
    ])('rejects %s', async (_name, overrides) => {
      const { service, migrationRepository } = buildService();

      const error = await create(service, overrides).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(rpcError(error)).toMatchObject({
        statusCode: 400,
        message: ResponseMessages.agent.error.migrationEndpointInvalid
      });
      expect(migrationRepository.create).not.toHaveBeenCalled();
    });

    it('rejects an org with no agent', async () => {
      const { service } = buildService({ agent: null });

      expect(rpcError(await create(service).catch((e) => e))).toMatchObject({ statusCode: 404 });
    });

    it('rejects an org that is not on the shared agent', async () => {
      const { service, migrationRepository } = buildService({
        agent: { ...sharedAgentRow, orgAgentTypeId: 'dedicated-type-id' }
      });

      const error = await create(service).catch((e) => e);

      expect(rpcError(error)).toMatchObject({
        statusCode: 400,
        message: ResponseMessages.agent.error.migrationOrgNotShared
      });
      expect(migrationRepository.create).not.toHaveBeenCalled();
    });

    it('passes the repository conflict for an already-active migration through with its status', async () => {
      const { service, migrationRepository } = buildService();
      migrationRepository.create.mockRejectedValue(
        new ConflictException(ResponseMessages.agent.error.migrationAlreadyActive)
      );

      expect(rpcError(await create(service).catch((e) => e))).toMatchObject({ statusCode: 409 });
    });
  });

  describe('getMigration / listMigrations', () => {
    it('returns the latest migration for the org', async () => {
      const { service, migrationRepository } = buildService();
      migrationRepository.getLatestByOrgId.mockResolvedValue({ id: MIGRATION_ID });

      await expect(service.getMigration(ORG_ID)).resolves.toEqual({ id: MIGRATION_ID });
    });

    it('404s when the org has never had one', async () => {
      const { service, migrationRepository } = buildService();
      migrationRepository.getLatestByOrgId.mockResolvedValue(null);

      expect(rpcError(await service.getMigration(ORG_ID).catch((e) => e))).toMatchObject({ statusCode: 404 });
    });

    it('findMigration answers null for an org that has never had one, instead of an error', async () => {
      const { service, migrationRepository } = buildService();
      migrationRepository.getLatestByOrgId.mockResolvedValue(null);

      await expect(service.findMigration(ORG_ID)).resolves.toBeNull();
    });

    it('findMigration returns the latest migration when there is one', async () => {
      const { service, migrationRepository } = buildService();
      migrationRepository.getLatestByOrgId.mockResolvedValue({ id: MIGRATION_ID });

      await expect(service.findMigration(ORG_ID)).resolves.toEqual({ id: MIGRATION_ID });
    });

    it.each([
      [{}, 0, 20],
      [{ pageNumber: 3, pageSize: 10 }, 20, 10],
      [{ pageNumber: 0, pageSize: 0 }, 0, 1],
      [{ pageNumber: 2, pageSize: 5000 }, 100, 100]
    ])('turns %j into a bounded page', async (payload, skip, take) => {
      const { service, migrationRepository } = buildService();

      await service.listMigrations({ orgId: ORG_ID, ...payload });

      expect(migrationRepository.list).toHaveBeenCalledWith({ orgId: ORG_ID, status: undefined, skip, take });
    });
  });

  describe('advance', () => {
    it('moves a migration along an allowed transition from its current state', async () => {
      const { service, migrationRepository } = buildService({
        migration: { id: MIGRATION_ID, status: Status.CREATED }
      });

      await service.advance(MIGRATION_ID, Status.REHEARSED, USER_ID, { rehearsalDurationMs: 1200 });

      expect(migrationRepository.transition).toHaveBeenCalledWith({
        id: MIGRATION_ID,
        from: Status.CREATED,
        to: Status.REHEARSED,
        actor: USER_ID,
        patch: { rehearsalDurationMs: 1200 }
      });
    });

    it.each([
      [Status.CREATED, Status.FROZEN],
      [Status.CUTOVER, Status.FAILED],
      [Status.COMPLETED, Status.ROTATING]
    ])('refuses %s -> %s without touching the row', async (from, to) => {
      const { service, migrationRepository } = buildService({ migration: { id: MIGRATION_ID, status: from } });

      await expect(service.advance(MIGRATION_ID, to, USER_ID)).rejects.toThrow(BadRequestException);
      expect(migrationRepository.transition).not.toHaveBeenCalled();
    });

    it('404s for an unknown migration', async () => {
      const { service } = buildService({ migration: null });

      await expect(service.advance(MIGRATION_ID, Status.REHEARSED, USER_ID)).rejects.toThrow('No migration found');
    });
  });

  describe('cancel', () => {
    it.each([Status.CREATED, Status.REHEARSED])('lets the owner call off a move in %s', async (status) => {
      const { service, migrationRepository } = buildService({
        migration: { id: MIGRATION_ID, status },
        active: { id: MIGRATION_ID, status }
      });

      await service.cancel(ORG_ID, USER_ID);

      expect(migrationRepository.transition).toHaveBeenCalledWith({
        id: MIGRATION_ID,
        from: status,
        to: Status.FAILED,
        actor: USER_ID,
        patch: { error: 'CANCELLED_BY_OWNER', targetTokenEncrypted: null }
      });
    });

    it('records who cancelled it', async () => {
      const { service, migrationRepository } = buildService();

      await service.cancel(ORG_ID, USER_ID);

      expect(migrationRepository.recordEvent).toHaveBeenCalledWith(MIGRATION_ID, {
        action: 'MOVE_CANCELLED',
        actor: USER_ID,
        detail: { by: 'OWNER' }
      });
    });

    it.each([
      Status.FROZEN,
      Status.EXPORTING,
      Status.IMPORTING,
      Status.VERIFYING,
      Status.CUTOVER,
      Status.STABILISING,
      Status.ROTATING
    ])('refuses once the move is in %s, because the move itself owns it by then', async (status) => {
      const { service, migrationRepository } = buildService({ active: { id: MIGRATION_ID, status } });

      await expect(service.cancel(ORG_ID, USER_ID)).rejects.toThrow(BadRequestException);

      expect(migrationRepository.transition).not.toHaveBeenCalled();
    });

    it('refuses when the scheduler started the move between the read and the write', async () => {
      const { service, migrationRepository } = buildService();
      migrationRepository.transition.mockRejectedValue(new ConflictException('changed'));

      await expect(service.cancel(ORG_ID, USER_ID)).rejects.toThrow(BadRequestException);

      expect(migrationRepository.recordEvent).not.toHaveBeenCalled();
    });

    it('refuses when the org has no active move', async () => {
      const { service } = buildService({ active: null });

      await expect(service.cancel(ORG_ID, USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('abort', () => {
    it('drops the stored token of the dedicated agent, since a finished migration has no use for it', async () => {
      const { service, migrationRepository } = buildService({
        migration: { id: MIGRATION_ID, status: Status.EXPORTING }
      });

      await service.abort(MIGRATION_ID, 'EXPORT_FAILED', null);

      expect(migrationRepository.transition.mock.calls[0][0].patch).toMatchObject({ targetTokenEncrypted: null });
    });

    it.each([Status.CREATED, Status.REHEARSED, Status.FROZEN, Status.EXPORTING, Status.IMPORTING, Status.VERIFYING])(
      'cancels a migration in %s with the error code recorded',
      async (status) => {
        const { service, migrationRepository } = buildService({ migration: { id: MIGRATION_ID, status } });

        await service.abort(MIGRATION_ID, 'VERIFICATION_FAILED', null);

        expect(migrationRepository.transition).toHaveBeenCalledWith({
          id: MIGRATION_ID,
          from: status,
          to: Status.FAILED,
          actor: null,
          patch: { error: 'VERIFICATION_FAILED', targetTokenEncrypted: null }
        });
      }
    );

    it.each([Status.CUTOVER, Status.STABILISING, Status.ROTATING, Status.COMPLETED, Status.FAILED])(
      'will not abort a migration in %s',
      async (status) => {
        const { service, migrationRepository } = buildService({ migration: { id: MIGRATION_ID, status } });

        await expect(service.abort(MIGRATION_ID, 'X', null)).rejects.toThrow(BadRequestException);
        expect(migrationRepository.transition).not.toHaveBeenCalled();
      }
    );
  });
});
