/**
 * Note this repo has no jest step in CI - run with:
 *   npx jest apps/agent-service/src/repositories/org-agent-migration.repository.spec.ts
 */
/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, implicit-arrow-linebreak */
import { ConflictException } from '@nestjs/common';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { OrgAgentMigrationRepository } from './org-agent-migration.repository';
import { OrgAgentMigrationPhase } from '../migration/org-agent-migration.state-machine';

const ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';
const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';

const buildRepository = (overrides: { updateCount?: number; existingScheduledFor?: Date | null } = {}) => {
  const migrationUpdateMany = jest.fn().mockResolvedValue({ count: overrides.updateCount ?? 1 });
  const migrationCreate = jest.fn().mockResolvedValue({ id: ID, status: Status.CREATED });
  const eventCreate = jest.fn().mockResolvedValue({});
  const tx = {
    org_agent_migrations: {
      create: migrationCreate,
      updateMany: migrationUpdateMany,
      findUnique: jest.fn().mockResolvedValue({ scheduledFor: overrides.existingScheduledFor ?? null }),
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
        phase: OrgAgentMigrationPhase.PREPARE,
        tenantId: 'tenant-1'
      });
      expect(eventCreate).toHaveBeenCalledWith({
        data: {
          migrationId: ID,
          fromStatus: null,
          toStatus: Status.CREATED,
          actor: USER_ID,
          detail: {
            targetAdminEndpoint: 'https://admin.example.com',
            targetDidcommEndpoint: 'https://didcomm.example.com'
          }
        }
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
        from: Status.REHEARSED,
        to: Status.FROZEN,
        actor: USER_ID,
        patch: { freezeDeadline: new Date('2026-10-20T00:00:00Z') }
      });

      expect(migrationUpdateMany).toHaveBeenCalledWith({
        where: { id: ID, status: Status.REHEARSED },
        data: {
          freezeDeadline: new Date('2026-10-20T00:00:00Z'),
          status: Status.FROZEN,
          phase: OrgAgentMigrationPhase.MOVE,
          lastChangedDateTime: expect.any(Date)
        }
      });
      expect(eventCreate).toHaveBeenCalledWith({
        data: { migrationId: ID, fromStatus: Status.REHEARSED, toStatus: Status.FROZEN, actor: USER_ID }
      });
    });

    it('names SYSTEM as the actor of a step no person made', async () => {
      const { repository, eventCreate } = buildRepository();

      await repository.transition({ id: ID, from: Status.STABILISING, to: Status.ROTATING, actor: null });

      expect(eventCreate.mock.calls[0][0].data.actor).toBe('SYSTEM');
    });

    it('carries the checksum and the import-key fingerprint on a state change once the export exists', async () => {
      const { repository, tx, eventCreate } = buildRepository();
      tx.org_agent_migrations.findUniqueOrThrow.mockResolvedValue({
        id: ID,
        checksum: 'sha256-of-the-export',
        importKeyFingerprint: 'fingerprint-of-the-key'
      });

      await repository.transition({ id: ID, from: Status.IMPORTING, to: Status.VERIFYING, actor: USER_ID });

      expect(eventCreate.mock.calls[0][0].data.detail).toEqual({
        checksum: 'sha256-of-the-export',
        importKeyFingerprint: 'fingerprint-of-the-key'
      });
    });

    it('leaves the detail out of a state change before there is anything to carry', async () => {
      const { repository, eventCreate } = buildRepository();

      await repository.transition({ id: ID, from: Status.CREATED, to: Status.REHEARSED, actor: USER_ID });

      expect(eventCreate.mock.calls[0][0].data).not.toHaveProperty('detail');
    });

    it('stamps the time a move completed, and only then', async () => {
      const done = buildRepository();
      await done.repository.transition({ id: ID, from: Status.ROTATING, to: Status.COMPLETED, actor: null });
      expect(done.migrationUpdateMany.mock.calls[0][0].data.completedAt).toBeInstanceOf(Date);

      const notDone = buildRepository();
      await notDone.repository.transition({ id: ID, from: Status.REHEARSED, to: Status.FROZEN, actor: USER_ID });
      expect(notDone.migrationUpdateMany.mock.calls[0][0].data).not.toHaveProperty('completedAt');
    });

    it('refuses, and records nothing, when another actor already moved the migration', async () => {
      const { repository, eventCreate } = buildRepository({ updateCount: 0 });

      await expect(
        repository.transition({ id: ID, from: Status.CREATED, to: Status.REHEARSED, actor: USER_ID })
      ).rejects.toThrow(ConflictException);
      expect(eventCreate).not.toHaveBeenCalled();
    });

    it('derives the phase from a slot being booked in the same patch', async () => {
      const { repository, migrationUpdateMany } = buildRepository();

      await repository.transition({
        id: ID,
        from: Status.REHEARSED,
        to: Status.REHEARSED,
        actor: USER_ID,
        patch: { scheduledFor: new Date('2026-10-25T02:00:00Z') }
      });

      expect(migrationUpdateMany.mock.calls[0][0].data.phase).toBe(OrgAgentMigrationPhase.SCHEDULED);
    });

    it('keeps the booked slot when a later patch does not touch it, and clears it when told to', async () => {
      const booked = buildRepository({ existingScheduledFor: new Date('2026-10-25T02:00:00Z') });
      await booked.repository.transition({ id: ID, from: Status.REHEARSED, to: Status.REHEARSED, actor: null });
      expect(booked.migrationUpdateMany.mock.calls[0][0].data.phase).toBe(OrgAgentMigrationPhase.SCHEDULED);

      const cleared = buildRepository({ existingScheduledFor: new Date('2026-10-25T02:00:00Z') });
      await cleared.repository.transition({
        id: ID,
        from: Status.REHEARSED,
        to: Status.REHEARSED,
        actor: null,
        patch: { scheduledFor: null }
      });
      expect(cleared.migrationUpdateMany.mock.calls[0][0].data.phase).toBe(OrgAgentMigrationPhase.PREPARE);
    });
  });

  describe('reads', () => {
    it('treats every non-terminal state as active', async () => {
      const { repository, findFirst } = buildRepository();
      findFirst.mockResolvedValue(null);

      await repository.getActiveByOrgId(ORG_ID);

      expect(findFirst).toHaveBeenCalledWith({
        where: { orgId: ORG_ID, status: { notIn: [Status.COMPLETED, Status.FAILED, Status.DISASTER_RESTORED] } }
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
