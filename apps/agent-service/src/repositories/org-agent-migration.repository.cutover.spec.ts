/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, prefer-destructuring */
import { ConflictException } from '@nestjs/common';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { OrgAgentMigrationRepository } from './org-agent-migration.repository';

const params = {
  migrationId: 'm1',
  orgId: 'org-1',
  expectedAgentEndPoint: 'https://shared.example.com',
  expectedTenantId: 'tenant-1',
  sharedOrgAgentTypeId: 'shared-type',
  dedicatedOrgAgentTypeId: 'dedicated-type',
  agentEndPoint: 'https://admin.org.example.com',
  encryptedToken: 'ENCRYPTED',
  walletName: 'org-wallet',
  lastChangedBy: 'user-1',
  actor: null,
  patch: { counts: { entries: 10, keys: 2 } }
};

const build = (counts: { agent?: number; migration?: number } = {}) => {
  const tx = {
    org_agents: { updateMany: jest.fn().mockResolvedValue({ count: counts.agent ?? 1 }) },
    org_agent_migrations: {
      updateMany: jest.fn().mockResolvedValue({ count: counts.migration ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'm1', status: Status.CUTOVER })
    },
    org_agent_migration_events: { create: jest.fn().mockResolvedValue({}) }
  };
  const prisma = { $transaction: jest.fn(async (work: (client: unknown) => unknown) => work(tx)) };
  return { tx, prisma, repository: new OrgAgentMigrationRepository(prisma as never, { error: jest.fn() } as never) };
};

describe('OrgAgentMigrationRepository.cutover', () => {
  it('switches the org row and moves the migration to CUTOVER in one transaction, with its event', async () => {
    const { repository, tx, prisma } = build();

    const result = await repository.cutover(params);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: Status.CUTOVER });
    expect(tx.org_agent_migration_events.create).toHaveBeenCalledWith({
      data: { migrationId: 'm1', fromStatus: Status.VERIFYING, toStatus: Status.CUTOVER, actor: 'SYSTEM' }
    });
  });

  it('names the person it is given as the actor, and carries the checksum and key fingerprint', async () => {
    const { repository, tx } = build();
    tx.org_agent_migrations.findUniqueOrThrow.mockResolvedValue({
      id: 'm1',
      status: Status.CUTOVER,
      checksum: 'sha256-of-the-export',
      importKeyFingerprint: 'fingerprint-of-the-key'
    });

    await repository.cutover({ ...params, actor: 'owner-1' });

    expect(tx.org_agent_migration_events.create).toHaveBeenCalledWith({
      data: {
        migrationId: 'm1',
        fromStatus: Status.VERIFYING,
        toStatus: Status.CUTOVER,
        actor: 'owner-1',
        detail: { checksum: 'sha256-of-the-export', importKeyFingerprint: 'fingerprint-of-the-key' }
      }
    });
  });

  it('only matches the shared row the move was prepared against', async () => {
    const { repository, tx } = build();

    await repository.cutover(params);

    expect(tx.org_agents.updateMany.mock.calls[0][0].where).toEqual({
      orgId: 'org-1',
      orgAgentTypeId: 'shared-type',
      agentEndPoint: 'https://shared.example.com',
      tenantId: 'tenant-1'
    });
  });

  it('writes the dedicated type, the new endpoint, the encrypted token, no tenant and the wallet name', async () => {
    const { repository, tx } = build();

    await repository.cutover(params);

    expect(tx.org_agents.updateMany.mock.calls[0][0].data).toMatchObject({
      orgAgentTypeId: 'dedicated-type',
      agentEndPoint: 'https://admin.org.example.com',
      apiKey: 'ENCRYPTED',
      tenantId: null,
      walletName: 'org-wallet',
      lastChangedBy: 'user-1'
    });
  });

  it('only moves a migration that is still VERIFYING, and applies the patch with the new state', async () => {
    const { repository, tx } = build();

    await repository.cutover(params);

    const [{ where, data }] = tx.org_agent_migrations.updateMany.mock.calls[0];
    expect(where).toEqual({ id: 'm1', status: Status.VERIFYING });
    expect(data).toMatchObject({ status: Status.CUTOVER, counts: { entries: 10, keys: 2 } });
  });

  it('refuses, and records nothing, when the org row changed', async () => {
    const { repository, tx } = build({ agent: 0 });

    await expect(repository.cutover(params)).rejects.toBeInstanceOf(ConflictException);

    expect(tx.org_agent_migrations.updateMany).not.toHaveBeenCalled();
    expect(tx.org_agent_migration_events.create).not.toHaveBeenCalled();
  });

  it('refuses when the migration is no longer VERIFYING, so the transaction rolls the org row back', async () => {
    const { repository, tx } = build({ migration: 0 });

    await expect(repository.cutover(params)).rejects.toBeInstanceOf(ConflictException);

    expect(tx.org_agent_migration_events.create).not.toHaveBeenCalled();
  });
});
