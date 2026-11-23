/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, prefer-destructuring */
import { ConflictException } from '@nestjs/common';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { OrgAgentMigrationRepository } from './org-agent-migration.repository';

const params = {
  migrationId: 'm1',
  orgId: 'org-1',
  expectedAgentEndPoint: 'https://admin.org.example.com',
  sharedOrgAgentTypeId: 'shared-type',
  dedicatedOrgAgentTypeId: 'dedicated-type',
  agentEndPoint: 'https://shared.example.com',
  tenantId: 'tenant-1',
  walletName: 'org-wallet',
  lastChangedBy: 'admin-1',
  actor: 'admin-1',
  newInvitationDid: 'did:peer:2.new'
};

const build = (counts: { agent?: number; migration?: number; invitations?: number } = {}) => {
  const tx = {
    org_agents: { updateMany: jest.fn().mockResolvedValue({ count: counts.agent ?? 1 }) },
    org_agent_migrations: {
      updateMany: jest.fn().mockResolvedValue({ count: counts.migration ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'm1', status: Status.DISASTER_RESTORED })
    },
    org_agent_migration_events: { create: jest.fn().mockResolvedValue({}) },
    agent_invitations: { deleteMany: jest.fn().mockResolvedValue({ count: counts.invitations ?? 1 }) }
  };
  const prisma = {
    $transaction: jest.fn(async (work: (client: unknown) => unknown) => work(tx)),
    user_org_roles: { findFirst: jest.fn() }
  };
  return { tx, prisma, repository: new OrgAgentMigrationRepository(prisma as never, { error: jest.fn() } as never) };
};

describe('OrgAgentMigrationRepository.restoreOrgAgent', () => {
  it('switches the org back, ends the move and removes the lost agent invitation in one transaction', async () => {
    const { repository, tx, prisma } = build();

    const result = await repository.restoreOrgAgent(params);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ migration: { id: 'm1', status: Status.DISASTER_RESTORED }, invitationsRemoved: 1 });
    expect(tx.org_agent_migration_events.create).toHaveBeenCalledWith({
      data: { migrationId: 'm1', fromStatus: Status.STABILISING, toStatus: Status.DISASTER_RESTORED, actor: 'admin-1' }
    });
  });

  it('only matches the dedicated row the move created', async () => {
    const { repository, tx } = build();

    await repository.restoreOrgAgent(params);

    expect(tx.org_agents.updateMany.mock.calls[0][0].where).toEqual({
      orgId: 'org-1',
      orgAgentTypeId: 'dedicated-type',
      agentEndPoint: 'https://admin.org.example.com'
    });
  });

  it('writes the shared type, the saved endpoint, tenant and wallet name, and clears the token', async () => {
    const { repository, tx } = build();

    await repository.restoreOrgAgent(params);

    expect(tx.org_agents.updateMany.mock.calls[0][0].data).toMatchObject({
      orgAgentTypeId: 'shared-type',
      agentEndPoint: 'https://shared.example.com',
      tenantId: 'tenant-1',
      walletName: 'org-wallet',
      apiKey: null,
      lastChangedBy: 'admin-1'
    });
  });

  it('only ends a move that is still in its stabilisation window', async () => {
    const { repository, tx } = build();

    await repository.restoreOrgAgent(params);

    const [{ where, data }] = tx.org_agent_migrations.updateMany.mock.calls[0];
    expect(where).toEqual({ id: 'm1', status: Status.STABILISING });
    expect(data).toMatchObject({ status: Status.DISASTER_RESTORED, error: null });
  });

  it('removes only the invitation made on the lost agent, for this org', async () => {
    const { repository, tx } = build();

    await repository.restoreOrgAgent(params);

    expect(tx.agent_invitations.deleteMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', invitationDid: 'did:peer:2.new' }
    });
  });

  it('removes no invitation when the move never made one', async () => {
    const { repository, tx } = build();

    const result = await repository.restoreOrgAgent({ ...params, newInvitationDid: null });

    expect(tx.agent_invitations.deleteMany).not.toHaveBeenCalled();
    expect(result.invitationsRemoved).toBe(0);
  });

  it('refuses, and records nothing, when the org row is not the one the move created', async () => {
    const { repository, tx } = build({ agent: 0 });

    await expect(repository.restoreOrgAgent(params)).rejects.toBeInstanceOf(ConflictException);

    expect(tx.org_agent_migrations.updateMany).not.toHaveBeenCalled();
    expect(tx.org_agent_migration_events.create).not.toHaveBeenCalled();
    expect(tx.agent_invitations.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses, and removes no invitation, when the move has left its stabilisation window', async () => {
    const { repository, tx } = build({ migration: 0 });

    await expect(repository.restoreOrgAgent(params)).rejects.toBeInstanceOf(ConflictException);

    expect(tx.org_agent_migration_events.create).not.toHaveBeenCalled();
    expect(tx.agent_invitations.deleteMany).not.toHaveBeenCalled();
  });
});

describe('OrgAgentMigrationRepository.isPlatformAdmin', () => {
  it('asks for the platform_admin role of that user', async () => {
    const { repository, prisma } = build();
    prisma.user_org_roles.findFirst.mockResolvedValue({ id: 'row' });

    await expect(repository.isPlatformAdmin('admin-1')).resolves.toBe(true);

    expect(prisma.user_org_roles.findFirst).toHaveBeenCalledWith({
      where: { userId: 'admin-1', orgRole: { name: 'platform_admin' } },
      select: { id: true }
    });
  });

  it('is false for anyone else', async () => {
    const { repository, prisma } = build();
    prisma.user_org_roles.findFirst.mockResolvedValue(null);

    await expect(repository.isPlatformAdmin('someone')).resolves.toBe(false);
  });
});
