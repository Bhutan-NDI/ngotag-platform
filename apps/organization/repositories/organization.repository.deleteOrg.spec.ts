/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { ConflictException } from '@nestjs/common';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';
import { OrganizationRepository } from './organization.repository';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const build = (activeMigrations = 0) => {
  const tx = {
    org_agent_migrations: { count: jest.fn().mockResolvedValue(activeMigrations) },
    org_agents: { findUnique: jest.fn().mockResolvedValue(null), delete: jest.fn() },
    org_dids: { count: jest.fn().mockResolvedValue(0) },
    agent_invitations: { count: jest.fn().mockResolvedValue(0) },
    connections: { count: jest.fn().mockResolvedValue(0) },
    credentials: { count: jest.fn().mockResolvedValue(0) },
    presentations: { count: jest.fn().mockResolvedValue(0) },
    file_upload: { count: jest.fn().mockResolvedValue(0) },
    notification: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    user_activity: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    user_org_roles: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    org_invitations: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    organisation: { delete: jest.fn().mockResolvedValue({ id: ORG_ID }) }
  };
  const prisma = {
    $transaction: jest.fn(async (work: (client: unknown) => unknown) => work(tx)),
    schema: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    credential_definition: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
  };
  const repository = new OrganizationRepository(prisma as never, { error: jest.fn() } as never, {} as never);
  return { repository, tx };
};

describe('OrganizationRepository.deleteOrg and wallet moves', () => {
  it('asks only about moves that are still running', async () => {
    const { repository, tx } = build();

    await repository.deleteOrg(ORG_ID);

    expect(tx.org_agent_migrations.count).toHaveBeenCalledWith({
      where: {
        orgId: ORG_ID,
        status: {
          notIn: [
            OrgAgentMigrationStatus.COMPLETED,
            OrgAgentMigrationStatus.FAILED,
            OrgAgentMigrationStatus.DISASTER_RESTORED
          ]
        }
      }
    });
  });

  it('refuses to delete an organisation with a move in progress, and changes nothing', async () => {
    const { repository, tx } = build(1);

    await expect(repository.deleteOrg(ORG_ID)).rejects.toBeInstanceOf(ConflictException);

    expect(tx.org_agents.findUnique).not.toHaveBeenCalled();
    expect(tx.org_agents.delete).not.toHaveBeenCalled();
    expect(tx.user_org_roles.deleteMany).not.toHaveBeenCalled();
    expect(tx.organisation.delete).not.toHaveBeenCalled();
  });

  it('still deletes an organisation whose moves are all over, leaving the move history alone', async () => {
    const { repository, tx } = build(0);

    await expect(repository.deleteOrg(ORG_ID)).resolves.toMatchObject({ deleteOrg: { id: ORG_ID } });

    expect(tx.organisation.delete).toHaveBeenCalledWith({ where: { id: ORG_ID } });
    expect(Object.keys(tx.org_agent_migrations)).toEqual(['count']);
  });
});
