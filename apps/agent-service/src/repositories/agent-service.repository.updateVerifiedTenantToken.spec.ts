/**
 * Regression cover for updateVerifiedTenantToken's compare-and-set: setDedicatedAgentToken verifies a
 * token against a snapshot of org_agents, then persists it. Without this, a concurrent
 * storeOrgAgentDetails changing the row's endpoint or type mid-probe would let the verified token land
 * on whatever replaced it.
 *
 * Note this repo has no jest step in CI - run with:
 *   npx jest apps/agent-service/src/repositories/agent-service.repository.updateVerifiedTenantToken.spec.ts
 */
/* eslint-disable camelcase */
import { AgentServiceRepository } from './agent-service.repository';
import { ConflictException } from '@nestjs/common';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const AGENT_ENDPOINT = 'https://agent.example.com';
const ORG_AGENT_TYPE_ID = 'dedicated-type-id';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';
const ENCRYPTED_TOKEN = 'encrypted-token-value';

const buildRepository = (updateManyResult: {
  count: number;
}): { repository: AgentServiceRepository; updateMany: jest.Mock } => {
  const updateMany = jest.fn().mockResolvedValue(updateManyResult);
  const prisma = { org_agents: { updateMany } };
  const repository = new AgentServiceRepository(prisma as never, { error: jest.fn() } as never);

  return { repository, updateMany };
};

describe('updateVerifiedTenantToken', () => {
  it('writes the token when the row still matches the endpoint and type it was verified against', async () => {
    const { repository, updateMany } = buildRepository({ count: 1 });

    await repository.updateVerifiedTenantToken(ORG_ID, AGENT_ENDPOINT, ORG_AGENT_TYPE_ID, ENCRYPTED_TOKEN, USER_ID);

    expect(updateMany).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, agentEndPoint: AGENT_ENDPOINT, orgAgentTypeId: ORG_AGENT_TYPE_ID },
      data: { apiKey: ENCRYPTED_TOKEN, lastChangedBy: USER_ID, lastChangedDateTime: expect.any(Date) }
    });
  });

  it('refuses to write when the row changed underneath the verified probe (lost the race)', async () => {
    const { repository } = buildRepository({ count: 0 });

    await expect(
      repository.updateVerifiedTenantToken(ORG_ID, AGENT_ENDPOINT, ORG_AGENT_TYPE_ID, ENCRYPTED_TOKEN, USER_ID)
    ).rejects.toThrow(ConflictException);
  });
});
