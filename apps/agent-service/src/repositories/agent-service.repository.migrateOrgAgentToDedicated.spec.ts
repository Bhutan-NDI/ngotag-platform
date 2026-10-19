/**
 * Cover for the org-agent migration cutover compare-and-set and the freeze lookup.
 *
 * Note this repo has no jest step in CI - run with:
 *   npx jest apps/agent-service/src/repositories/agent-service.repository.migrateOrgAgentToDedicated.spec.ts
 */
/* eslint-disable camelcase */
import { AgentServiceRepository } from './agent-service.repository';
import { ConflictException } from '@nestjs/common';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';

const params = {
  orgId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  expectedAgentEndPoint: 'https://shared.example.com',
  expectedTenantId: 'tenant-1',
  sharedOrgAgentTypeId: 'shared-type-id',
  dedicatedOrgAgentTypeId: 'dedicated-type-id',
  agentEndPoint: 'https://dedicated.example.com',
  encryptedToken: 'encrypted-root-token',
  walletName: 'org-wallet',
  lastChangedBy: 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6'
};

const buildRepository = (prisma: object): AgentServiceRepository =>
  new AgentServiceRepository(prisma as never, { error: jest.fn() } as never);

describe('migrateOrgAgentToDedicated', () => {
  it('flips the shared row to dedicated only when it still matches the prepared shared row', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const repository = buildRepository({ org_agents: { updateMany } });

    await repository.migrateOrgAgentToDedicated(params);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        orgId: params.orgId,
        orgAgentTypeId: 'shared-type-id',
        agentEndPoint: 'https://shared.example.com',
        tenantId: 'tenant-1'
      },
      data: {
        orgAgentTypeId: 'dedicated-type-id',
        agentEndPoint: 'https://dedicated.example.com',
        apiKey: 'encrypted-root-token',
        tenantId: null,
        walletName: 'org-wallet',
        lastChangedBy: params.lastChangedBy,
        lastChangedDateTime: expect.any(Date)
      }
    });
  });

  it('refuses when the row changed underneath the migration', async () => {
    const repository = buildRepository({ org_agents: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } });

    await expect(repository.migrateOrgAgentToDedicated(params)).rejects.toThrow(ConflictException);
  });
});

describe('isOrgAgentMigrationFrozen', () => {
  it('queries only the statuses during which the org is frozen', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'm1' });
    const repository = buildRepository({ org_agent_migrations: { findFirst } });

    await expect(repository.isOrgAgentMigrationFrozen(params.orgId)).resolves.toBe(true);

    const { status } = findFirst.mock.calls[0][0].where;
    expect(status.in).toEqual([
      OrgAgentMigrationStatus.FROZEN,
      OrgAgentMigrationStatus.EXPORTING,
      OrgAgentMigrationStatus.IMPORTING,
      OrgAgentMigrationStatus.VERIFYING,
      OrgAgentMigrationStatus.CUTOVER
    ]);
  });

  it('is false when no frozen migration exists', async () => {
    const repository = buildRepository({ org_agent_migrations: { findFirst: jest.fn().mockResolvedValue(null) } });

    await expect(repository.isOrgAgentMigrationFrozen(params.orgId)).resolves.toBe(false);
  });
});
