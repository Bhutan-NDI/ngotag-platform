/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, prefer-destructuring */
import { OrgAgentMigrationRepository } from './org-agent-migration.repository';

const build = (updateCount = 1) => {
  const prisma = {
    org_agent_migrations: {
      updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      findMany: jest.fn().mockResolvedValue([{ id: 'm1' }])
    },
    org_agent_migration_events: { findFirst: jest.fn() }
  };
  return { prisma, repository: new OrgAgentMigrationRepository(prisma as never, { error: jest.fn() } as never) };
};

describe('OrgAgentMigrationRepository scheduling queries', () => {
  describe('tryAcquireLease', () => {
    it('takes the lease only when there is none or it has run out', async () => {
      const { repository, prisma } = build();

      await expect(repository.tryAcquireLease('m1', 60000)).resolves.toBe(true);

      const [{ where, data }] = prisma.org_agent_migrations.updateMany.mock.calls[0];
      expect(where.id).toBe('m1');
      expect(where.OR).toEqual([{ leaseUntil: null }, { leaseUntil: { lt: expect.any(Date) } }]);
      expect(data.leaseUntil.getTime() - Date.now()).toBeGreaterThan(55000);
      expect(data.leaseUntil.getTime() - Date.now()).toBeLessThanOrEqual(60000);
    });

    it('reports false when someone else holds a live lease', async () => {
      const { repository } = build(0);

      await expect(repository.tryAcquireLease('m1', 60000)).resolves.toBe(false);
    });
  });

  describe('releaseLease', () => {
    it('clears the lease on that migration, so the next attempt does not wait for it to run out', async () => {
      const { repository, prisma } = build();

      await repository.releaseLease('m1');

      expect(prisma.org_agent_migrations.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { leaseUntil: null }
      });
    });
  });

  describe('findDueForStart', () => {
    it('asks for rehearsed moves with a finished rehearsal whose slot has arrived, earliest first', async () => {
      const { repository, prisma } = build();
      const now = new Date();

      await expect(repository.findDueForStart(now, 2)).resolves.toEqual([{ id: 'm1' }]);

      expect(prisma.org_agent_migrations.findMany).toHaveBeenCalledWith({
        where: {
          status: 'REHEARSED',
          rehearsalStatus: 'DONE',
          scheduledFor: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
        },
        orderBy: { scheduledFor: 'asc' },
        take: 2
      });
    });
  });

  describe('findStalled', () => {
    it('finds frozen moves past their deadline and switched-over moves with no progress, outside any live lease', async () => {
      const { repository, prisma } = build();
      const now = new Date('2026-10-23T10:00:00Z');

      await repository.findStalled(now, 5 * 60 * 1000);

      const cutoff = new Date('2026-10-23T09:55:00Z');
      expect(prisma.org_agent_migrations.findMany).toHaveBeenCalledWith({
        where: {
          AND: [
            { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
            {
              OR: [
                { status: { in: ['FROZEN', 'EXPORTING', 'IMPORTING', 'VERIFYING'] }, freezeDeadline: { lt: cutoff } },
                { status: 'CUTOVER', lastChangedDateTime: { lt: cutoff } }
              ]
            }
          ]
        }
      });
    });

    it('never asks for a move that has not been switched over and is not frozen', async () => {
      const { repository, prisma } = build();

      await repository.findStalled(new Date(), 1000);

      const text = JSON.stringify(prisma.org_agent_migrations.findMany.mock.calls[0][0]);
      for (const status of ['REHEARSED', 'CREATED', 'STABILISING', 'ROTATING', 'COMPLETED', 'FAILED']) {
        expect(text).not.toContain(`"${status}"`);
      }
    });
  });

  describe('findWindowEnded', () => {
    it('asks for stabilising moves whose window has ended, earliest first, outside any live lease', async () => {
      const { repository, prisma } = build();
      const now = new Date();

      await repository.findWindowEnded(now, 5);

      expect(prisma.org_agent_migrations.findMany).toHaveBeenCalledWith({
        where: {
          status: 'STABILISING',
          stabilisationEndsAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
        },
        orderBy: { stabilisationEndsAt: 'asc' },
        take: 5
      });
    });
  });

  describe('findRotating', () => {
    it('asks for rotating moves outside any live lease, oldest first', async () => {
      const { repository, prisma } = build();
      const now = new Date();

      await repository.findRotating(now, 5);

      expect(prisma.org_agent_migrations.findMany).toHaveBeenCalledWith({
        where: { status: 'ROTATING', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        orderBy: { createDateTime: 'asc' },
        take: 5
      });
    });
  });

  describe('getConfirmingActor', () => {
    it('returns the latest confirmation, or null', async () => {
      const { repository, prisma } = build();
      prisma.org_agent_migration_events.findFirst
        .mockResolvedValueOnce({ actor: 'owner-1' })
        .mockResolvedValueOnce(null);

      await expect(repository.getConfirmingActor('m1')).resolves.toBe('owner-1');
      await expect(repository.getConfirmingActor('m1')).resolves.toBeNull();

      expect(prisma.org_agent_migration_events.findFirst.mock.calls[0][0]).toMatchObject({
        where: { migrationId: 'm1', action: 'MOVE_CONFIRMED' },
        orderBy: { createDateTime: 'desc' }
      });
    });
  });
});
