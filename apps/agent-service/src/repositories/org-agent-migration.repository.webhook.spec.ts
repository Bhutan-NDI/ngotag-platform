/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { OrgAgentMigrationRepository } from './org-agent-migration.repository';

const build = (updateCount = 1) => {
  const prisma = {
    org_agent_migrations: {
      updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      findMany: jest.fn().mockResolvedValue([{ id: 'm1' }])
    }
  };
  return { prisma, repository: new OrgAgentMigrationRepository(prisma as never, { error: jest.fn() } as never) };
};

describe('OrgAgentMigrationRepository webhook probe queries', () => {
  describe('tryBeginWebhookProbe', () => {
    it('takes the probe slot only when it is empty or the probe in it has expired', async () => {
      const { repository, prisma } = build();
      const now = new Date('2026-10-26T10:00:00Z');
      const expiresAt = new Date('2026-10-26T10:05:00Z');

      await expect(repository.tryBeginWebhookProbe('m1', 'hash', expiresAt, now)).resolves.toBe(true);

      expect(prisma.org_agent_migrations.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', OR: [{ webhookProbeHash: null }, { webhookProbeExpiresAt: { lt: now } }] },
        data: { webhookProbeHash: 'hash', webhookProbeExpiresAt: expiresAt }
      });
    });

    it('reports false when a live probe is already out', async () => {
      const { repository } = build(0);

      await expect(repository.tryBeginWebhookProbe('m1', 'hash', new Date())).resolves.toBe(false);
    });
  });

  describe('confirmWebhookProbe', () => {
    it("consumes the probe, once, for that org's unfinished migration, while it has not expired", async () => {
      const { repository, prisma } = build();
      const now = new Date('2026-10-26T10:00:00Z');

      await expect(repository.confirmWebhookProbe('org-1', 'hash', now)).resolves.toBe(true);

      expect(prisma.org_agent_migrations.updateMany).toHaveBeenCalledWith({
        where: {
          orgId: 'org-1',
          status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'DISASTER_RESTORED'] },
          webhookProbeHash: 'hash',
          webhookProbeExpiresAt: { gt: now }
        },
        data: { webhookProbeHash: null, webhookProbeExpiresAt: null, webhookConfirmedAt: now }
      });
    });

    it.each([
      ['an unknown, expired or already used probe', 0],
      ['a probe of another organisation', 0]
    ])('reports false for %s', async (_name, count) => {
      const { repository } = build(count);

      await expect(repository.confirmWebhookProbe('org-1', 'guess')).resolves.toBe(false);
    });
  });

  describe('endWebhookProbe', () => {
    it('frees the slot only if it still holds the probe that took it', async () => {
      const { repository, prisma } = build();

      await repository.endWebhookProbe('m1', 'hash');

      expect(prisma.org_agent_migrations.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', webhookProbeHash: 'hash' },
        data: { webhookProbeHash: null, webhookProbeExpiresAt: null }
      });
    });
  });

  describe('findAwaitingWebhook', () => {
    it('asks for stabilising migrations with an open window, no confirmed webhook and a try that is due', async () => {
      const { repository, prisma } = build();
      const now = new Date();
      const retryBefore = new Date(now.getTime() - 10 * 60 * 1000);

      await expect(repository.findAwaitingWebhook(now, retryBefore, 5)).resolves.toEqual([{ id: 'm1' }]);

      expect(prisma.org_agent_migrations.findMany).toHaveBeenCalledWith({
        where: {
          status: 'STABILISING',
          webhookConfirmedAt: null,
          stabilisationEndsAt: { gt: now },
          OR: [{ webhookCheckedAt: null }, { webhookCheckedAt: { lt: retryBefore } }]
        },
        orderBy: { stabilisationEndsAt: 'asc' },
        take: 5
      });
    });

    it('never looks at the lease, which a restore needs', async () => {
      const { repository, prisma } = build();

      await repository.findAwaitingWebhook(new Date(), new Date(), 5);

      expect(JSON.stringify(prisma.org_agent_migrations.findMany.mock.calls[0][0])).not.toContain('leaseUntil');
    });
  });

  describe('tryBeginWebhookCheck', () => {
    it('takes the try only when none ran within the spacing, and only for one replica', async () => {
      const { repository, prisma } = build();
      const now = new Date();
      const retryBefore = new Date(now.getTime() - 600000);
      prisma.org_agent_migrations.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      await expect(repository.tryBeginWebhookCheck('m1', now, retryBefore)).resolves.toBe(true);
      await expect(repository.tryBeginWebhookCheck('m1', now, retryBefore)).resolves.toBe(false);

      expect(prisma.org_agent_migrations.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', OR: [{ webhookCheckedAt: null }, { webhookCheckedAt: { lt: retryBefore } }] },
        data: { webhookCheckedAt: now }
      });
    });
  });

  describe('updateIfStatus', () => {
    it('writes only while the migration is still in the given status, and says whether it did', async () => {
      const { repository, prisma } = build();
      prisma.org_agent_migrations.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      await expect(
        repository.updateIfStatus('m1', 'STABILISING' as never, { error: 'WEBHOOK_UNREACHABLE' })
      ).resolves.toBe(true);
      await expect(repository.updateIfStatus('m1', 'STABILISING' as never, { error: null })).resolves.toBe(false);

      expect(prisma.org_agent_migrations.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', status: 'STABILISING' },
        data: { error: 'WEBHOOK_UNREACHABLE', lastChangedDateTime: expect.any(Date) }
      });
    });
  });
});
