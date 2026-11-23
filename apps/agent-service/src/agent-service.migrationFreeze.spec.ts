/**
 * Cover for the org-agent migration freeze guard: org-initiated agent calls must fail with 423
 * ORG_AGENT_MIGRATING while the org's migration is frozen, and that 423 must survive the RPC rewrap
 * to the gateway instead of turning into a 500.
 *
 * Note this repo has no jest step in CI - run with:
 *   npx jest apps/agent-service/src/agent-service.migrationFreeze.spec.ts
 */
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from '@credebl/common/exception-handler';
import { AgentServiceService } from './agent-service.service';
import { RpcException } from '@nestjs/microservices';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const buildService = (frozen: boolean): { service: AgentServiceService; repository: Record<string, jest.Mock> } => {
  const repository = {
    isOrgAgentMigrationFrozen: jest.fn().mockResolvedValue(frozen),
    getAgentApiKey: jest.fn().mockResolvedValue(null),
    getOrgAgentTypeDetails: jest.fn().mockResolvedValue('shared-type-id')
  };
  const service = new AgentServiceService(
    repository as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never
  );
  return { service, repository };
};

describe('org agent migration freeze guard', () => {
  it('getOrgAgentApiKey fails with 423 before touching the agent row', async () => {
    const { service, repository } = buildService(true);

    const error = await service.getOrgAgentApiKey(ORG_ID).catch((e) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.LOCKED);
    expect(error.getResponse()).toMatchObject({ statusCode: 423, error: 'ORG_AGENT_MIGRATING' });
    expect(repository.getAgentApiKey).not.toHaveBeenCalled();
  });

  it('getOrgAgentApiKey proceeds as before when the org is not frozen', async () => {
    const { service } = buildService(false);

    await expect(service.getOrgAgentApiKey(ORG_ID)).rejects.toThrow(NotFoundException);
  });

  it('deleteWallet surfaces 423 instead of the 500 its allSettled wrapper would produce', async () => {
    const { service, repository } = buildService(true);

    const error = await service.deleteWallet(ORG_ID, {} as never).catch((e) => e);

    expect(error).toBeInstanceOf(RpcException);
    expect(error.getError()).toMatchObject({ statusCode: 423, error: 'ORG_AGENT_MIGRATING' });
    expect(repository.getAgentApiKey).not.toHaveBeenCalled();
  });

  it('setDedicatedAgentToken refuses to store a token while frozen', async () => {
    const { service, repository } = buildService(true);

    const error = await service
      .setDedicatedAgentToken({
        targetOrgId: ORG_ID,
        agentToken: 't',
        agentEndPoint: 'https://a.example.com',
        userId: 'u'
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(RpcException);
    expect(error.getError()).toMatchObject({ statusCode: 423 });
    expect(repository.getAgentApiKey).not.toHaveBeenCalled();
  });

  it('the gateway filter turns the rewrapped RpcException into HTTP 423', async () => {
    const { service } = buildService(true);
    const rpcError = await service.deleteWallet(ORG_ID, {} as never).catch((e) => e);

    const reply = jest.fn();
    const filter = new AllExceptionsFilter({ httpAdapter: { reply } } as never);
    const ctx = { getRequest: (): object => ({ method: 'DELETE', url: '/x' }), getResponse: (): object => ({}) };
    const host = { switchToHttp: (): typeof ctx => ctx };
    filter.catch(rpcError, host as never);

    expect(reply).toHaveBeenCalledWith({}, expect.objectContaining({ statusCode: 423 }), 423);
  });
});
