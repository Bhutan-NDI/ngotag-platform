/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { OrgAgentMigrationRepository } from './org-agent-migration.repository';

const ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';
const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';

const build = () => {
  const prisma = {
    org_agent_migrations: { findUnique: jest.fn().mockResolvedValue({ status: 'REHEARSED' }) },
    org_agent_migration_events: { create: jest.fn().mockResolvedValue({}) },
    user_org_roles: { findFirst: jest.fn(), findMany: jest.fn() },
    organisation: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() }
  };
  return { prisma, repository: new OrgAgentMigrationRepository(prisma as never, { error: jest.fn() } as never) };
};

describe('OrgAgentMigrationRepository audit and access queries', () => {
  describe('recordEvent', () => {
    it("writes the action against the migration's current status, so it is not mistaken for a state change", async () => {
      const { repository, prisma } = build();

      await repository.recordEvent(ID, { action: 'PREFLIGHT_RUN', actor: USER_ID, detail: { passed: true } });

      expect(prisma.org_agent_migration_events.create).toHaveBeenCalledWith({
        data: {
          migrationId: ID,
          fromStatus: 'REHEARSED',
          toStatus: 'REHEARSED',
          actor: USER_ID,
          action: 'PREFLIGHT_RUN',
          detail: { passed: true }
        }
      });
    });

    it('names SYSTEM as the actor of an entry no person made', async () => {
      const { repository, prisma } = build();

      await repository.recordEvent(ID, { action: 'PROFILE_PURGED', actor: null });

      expect(prisma.org_agent_migration_events.create.mock.calls[0][0].data.actor).toBe('SYSTEM');
    });

    it('leaves the detail out when there is none', async () => {
      const { repository, prisma } = build();

      await repository.recordEvent(ID, { action: 'ACCESS_DENIED', actor: null });

      expect(prisma.org_agent_migration_events.create.mock.calls[0][0].data).not.toHaveProperty('detail');
    });

    it('writes nothing for a migration that does not exist', async () => {
      const { repository, prisma } = build();
      prisma.org_agent_migrations.findUnique.mockResolvedValue(null);

      await repository.recordEvent(ID, { action: 'PREFLIGHT_RUN', actor: USER_ID });

      expect(prisma.org_agent_migration_events.create).not.toHaveBeenCalled();
    });
  });

  describe('isOrgOwner', () => {
    it('asks for the owner role in that organisation only', async () => {
      const { repository, prisma } = build();
      prisma.user_org_roles.findFirst.mockResolvedValue({ id: 'role-row' });

      await expect(repository.isOrgOwner(ORG_ID, USER_ID)).resolves.toBe(true);

      expect(prisma.user_org_roles.findFirst).toHaveBeenCalledWith({
        where: { orgId: ORG_ID, userId: USER_ID, orgRole: { name: 'owner' } },
        select: { id: true }
      });
    });

    it('is false when the user holds no owner role there', async () => {
      const { repository, prisma } = build();
      prisma.user_org_roles.findFirst.mockResolvedValue(null);

      await expect(repository.isOrgOwner(ORG_ID, USER_ID)).resolves.toBe(false);
    });
  });

  describe('getExportAlertRecipients', () => {
    it("returns the org's owners and the platform-admin organisation's members, once each and lower-cased", async () => {
      const { repository, prisma } = build();
      prisma.user_org_roles.findMany.mockResolvedValue([
        { user: { email: 'Owner@Example.com' } },
        { user: { email: 'admin@example.com' } },
        { user: { email: ' owner@example.com ' } },
        { user: { email: null } },
        { user: null }
      ]);

      const recipients = await repository.getExportAlertRecipients(ORG_ID, 'Platform-admin');

      expect(recipients).toEqual(['owner@example.com', 'admin@example.com']);
      expect(prisma.user_org_roles.findMany.mock.calls[0][0].where).toEqual({
        OR: [{ orgId: ORG_ID, orgRole: { name: 'owner' } }, { organisation: { name: 'Platform-admin' } }]
      });
    });
  });

  it('reads the org name and a user email, or null when they are gone', async () => {
    const { repository, prisma } = build();
    prisma.organisation.findUnique.mockResolvedValueOnce({ name: 'Acme' }).mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValueOnce({ email: 'a@b.c' }).mockResolvedValueOnce(null);

    await expect(repository.getOrgName(ORG_ID)).resolves.toBe('Acme');
    await expect(repository.getOrgName(ORG_ID)).resolves.toBeNull();
    await expect(repository.getUserEmail(USER_ID)).resolves.toBe('a@b.c');
    await expect(repository.getUserEmail(USER_ID)).resolves.toBeNull();
  });
});
