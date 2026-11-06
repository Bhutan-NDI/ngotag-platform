/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { OrgAgentMigrationRepository } from './org-agent-migration.repository';

describe('OrgAgentMigrationRepository.attachNewInvitation', () => {
  const params = {
    migrationId: 'migration-1',
    orgId: 'org-1',
    agentId: 'agent-1',
    connectionInvitation: 'https://short.example.com/abc',
    newInvitationDid: 'did:peer:2.new',
    legacyInvitationDid: 'did:peer:2.legacy'
  };

  const build = (failOn?: 'invitation' | 'migration') => {
    const tx = {
      agent_invitations: {
        create: jest.fn(async () => {
          if ('invitation' === failOn) {
            throw new Error('insert failed');
          }
          return {};
        })
      },
      org_agent_migrations: {
        update: jest.fn(async () => {
          if ('migration' === failOn) {
            throw new Error('update failed');
          }
          return { id: params.migrationId };
        })
      }
    };
    const prisma = { $transaction: jest.fn(async (run: (client: unknown) => Promise<unknown>) => run(tx)) };
    return { repository: new OrgAgentMigrationRepository(prisma as never, { error: jest.fn() } as never), tx, prisma };
  };

  it('saves the multi-use invitation and records its DID in one transaction', async () => {
    const { repository, tx, prisma } = build();

    await repository.attachNewInvitation(params);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.agent_invitations.create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        agentId: 'agent-1',
        connectionInvitation: 'https://short.example.com/abc',
        multiUse: true,
        invitationDid: 'did:peer:2.new'
      }
    });
    expect(tx.org_agent_migrations.update).toHaveBeenCalledWith({
      where: { id: 'migration-1' },
      data: expect.objectContaining({ newInvitationDid: 'did:peer:2.new', legacyInvitationDid: 'did:peer:2.legacy' })
    });
  });

  it.each(['invitation', 'migration'] as const)(
    'surfaces a failure of the %s write so the transaction rolls back',
    async (failOn) => {
      const { repository } = build(failOn);

      await expect(repository.attachNewInvitation(params)).rejects.toThrow();
    }
  );
});
