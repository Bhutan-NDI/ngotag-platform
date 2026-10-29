/**
 * Note this repo has no jest step in CI - run with:
 *   npx jest apps/agent-service/src/repositories/org-agent-migration.repository.spec.ts
 */
/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, implicit-arrow-linebreak */
import { ConflictException } from '@nestjs/common';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { OrgAgentMigrationRepository } from './org-agent-migration.repository';

const ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';
const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';

const buildRepository = (overrides: { updateCount?: number } = {}) => {
  const migrationUpdateMany = jest.fn().mockResolvedValue({ count: overrides.updateCount ?? 1 });
  const migrationCreate = jest.fn().mockResolvedValue({ id: ID, status: Status.CREATED });
  const eventCreate = jest.fn().mockResolvedValue({});
  const tx = {
    org_agent_migrations: {
      create: migrationCreate,
      updateMany: migrationUpdateMany,
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: ID })
    },
    org_agent_migration_events: { create: eventCreate }
  };
  const findFirst = jest.fn();
  const prisma = {
    $transaction: jest.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (client: unknown) => Promise<unknown>)(tx)
    ),
    org_agent_migrations: {
      findFirst,
      updateMany: migrationUpdateMany,
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(3),
      findMany: jest.fn().mockResolvedValue([])
    }
  };
  const repository = new OrgAgentMigrationRepository(prisma as never, { error: jest.fn() } as never);
  return { repository, prisma, tx, migrationCreate, migrationUpdateMany, eventCreate, findFirst };
};

describe('OrgAgentMigrationRepository', () => {
  describe('create', () => {
    it('creates the migration in CREATED and records its first event in the same transaction', async () => {
      const { repository, migrationCreate, eventCreate, prisma } = buildRepository();

      await repository.create({
        orgId: ORG_ID,
        startedBy: USER_ID,
        tenantId: 'tenant-1',
        sourceOrgAgentSnapshot: { agentEndPoint: 'https://shared.example.com' },
        targetAdminEndpoint: 'https://admin.example.com',
        targetDidcommEndpoint: 'https://didcomm.example.com'
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(migrationCreate.mock.calls[0][0].data).toMatchObject({
        orgId: ORG_ID,
        startedBy: USER_ID,
        status: Status.CREATED,
        tenantId: 'tenant-1'
      });
      expect(eventCreate).toHaveBeenCalledWith({
        data: { migrationId: ID, fromStatus: null, toStatus: Status.CREATED, actor: USER_ID }
      });
    });

    it('turns the partial unique index violation into a conflict', async () => {
      const { repository, prisma } = buildRepository();
      prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));

      await expect(
        repository.create({
          orgId: ORG_ID,
          startedBy: USER_ID,
          tenantId: null,
          sourceOrgAgentSnapshot: {},
          targetAdminEndpoint: 'https://admin.example.com',
          targetDidcommEndpoint: 'https://didcomm.example.com'
        })
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('transition', () => {
    it('only updates a row still in the expected state, and records the event', async () => {
      const { repository, migrationUpdateMany, eventCreate } = buildRepository();

      await repository.transition({
        id: ID,
        from: Status.SCHEDULED,
        to: Status.FROZEN,
        actor: USER_ID,
        patch: { freezeDeadline: new Date('2026-10-20T00:00:00Z') }
      });

      expect(migrationUpdateMany).toHaveBeenCalledWith({
        where: { id: ID, status: Status.SCHEDULED },
        data: {
          freezeDeadline: new Date('2026-10-20T00:00:00Z'),
          status: Status.FROZEN,
          lastChangedDateTime: expect.any(Date)
        }
      });
      expect(eventCreate).toHaveBeenCalledWith({
        data: { migrationId: ID, fromStatus: Status.SCHEDULED, toStatus: Status.FROZEN, actor: USER_ID }
      });
    });

    it('records a system step with no actor', async () => {
      const { repository, eventCreate } = buildRepository();

      await repository.transition({ id: ID, from: Status.STABILISING, to: Status.ROTATING, actor: null });

      expect(eventCreate.mock.calls[0][0].data.actor).toBeNull();
    });

    it('refuses, and records nothing, when another actor already moved the migration', async () => {
      const { repository, eventCreate } = buildRepository({ updateCount: 0 });

      await expect(
        repository.transition({ id: ID, from: Status.CREATED, to: Status.REHEARSED, actor: USER_ID })
      ).rejects.toThrow(ConflictException);
      expect(eventCreate).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('writes by id alone when no status is given', async () => {
      const { repository, prisma } = buildRepository();
      (prisma.org_agent_migrations as unknown as Record<string, jest.Mock>).update = jest
        .fn()
        .mockResolvedValue({ id: ID });

      await repository.update(ID, { error: null });

      expect((prisma.org_agent_migrations as unknown as Record<string, jest.Mock>).update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { error: null, lastChangedDateTime: expect.any(Date) }
      });
    });

    it('writes only while the migration is in one of the given statuses, and refuses once it has moved on', async () => {
      const { repository, migrationUpdateMany, prisma } = buildRepository();
      (prisma.org_agent_migrations as unknown as Record<string, jest.Mock>).findUniqueOrThrow = jest
        .fn()
        .mockResolvedValue({ id: ID });

      await repository.update(ID, { error: null }, [Status.CREATED, Status.SCHEDULED]);
      expect(migrationUpdateMany).toHaveBeenCalledWith({
        where: { id: ID, status: { in: [Status.CREATED, Status.SCHEDULED] } },
        data: { error: null, lastChangedDateTime: expect.any(Date) }
      });

      migrationUpdateMany.mockResolvedValueOnce({ count: 0 });
      await expect(repository.update(ID, { error: null }, [Status.CREATED])).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('tryStartRehearsal', () => {
    it('only starts on a migration that is not booked or moving', async () => {
      const { repository, migrationUpdateMany } = buildRepository();

      await repository.tryStartRehearsal(ID, new Date(0));

      expect(migrationUpdateMany.mock.calls[0][0].where.status).toEqual({ in: [Status.CREATED, Status.REHEARSED] });
    });
  });

  describe('touchRehearsal', () => {
    it('freshens the start time of a rehearsal that is running, and of no other', async () => {
      const { repository, migrationUpdateMany } = buildRepository();

      await repository.touchRehearsal(ID);

      expect(migrationUpdateMany).toHaveBeenCalledWith({
        where: { id: ID, rehearsalStatus: 'RUNNING' },
        data: { rehearsalStartedAt: expect.any(Date) }
      });
    });
  });

  describe('reads', () => {
    it('treats every non-terminal state as active', async () => {
      const { repository, findFirst } = buildRepository();
      findFirst.mockResolvedValue(null);

      await repository.getActiveByOrgId(ORG_ID);

      expect(findFirst).toHaveBeenCalledWith({
        where: {
          orgId: ORG_ID,
          status: { notIn: [Status.COMPLETED, Status.FAILED, Status.CANCELLED, Status.DISASTER_RESTORED] }
        }
      });
    });

    it('falls back to the most recent finished migration when none is active', async () => {
      const { repository, findFirst } = buildRepository();
      findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'old' });

      await expect(repository.getLatestByOrgId(ORG_ID)).resolves.toEqual({ id: 'old' });
      expect(findFirst.mock.calls[1][0]).toEqual({ where: { orgId: ORG_ID }, orderBy: { createDateTime: 'desc' } });
    });

    it('lists with the filters and page it was given', async () => {
      const { repository, prisma } = buildRepository();

      const result = await repository.list({ orgId: ORG_ID, status: Status.FROZEN, skip: 20, take: 10 });

      expect(prisma.org_agent_migrations.findMany).toHaveBeenCalledWith({
        where: { orgId: ORG_ID, status: Status.FROZEN },
        orderBy: { createDateTime: 'desc' },
        skip: 20,
        take: 10
      });
      expect(result.total).toBe(3);
    });
  });
});
