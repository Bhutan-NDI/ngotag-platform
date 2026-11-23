/* eslint-disable camelcase -- Mirrors the repository's org_agents relation name. */
import { HttpException, HttpStatus } from '@nestjs/common';
import { CommonConstants } from '@credebl/common/common.constant';
import { OrgAgentType } from '@credebl/enum/enum';
import { AgentServiceService } from './agent-service.service';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ENDPOINT = 'https://agent.example.org';

const build = (
  agentType: OrgAgentType,
  tenantId: string | null
): {
  service: AgentServiceService;
  repository: Record<string, jest.Mock>;
  commonService: Record<string, jest.Mock>;
} => {
  const repository = {
    isOrgAgentMigrationFrozen: jest.fn().mockResolvedValue(false),
    getAgentApiKey: jest
      .fn()
      .mockResolvedValue({ orgId: ORG_ID, orgAgentTypeId: 'type-id', tenantId, agentEndPoint: ENDPOINT, orgDid: null }),
    getOrgAgentType: jest.fn().mockResolvedValue({ agent: agentType }),
    platformAdminAgent: jest.fn().mockResolvedValue({ org_agents: [{ apiKey: 'encrypted-admin-key' }] }),
    deleteOrgAgentByOrg: jest
      .fn()
      .mockResolvedValue({ orgDid: { count: 0 }, agentInvitation: { count: 0 }, deleteOrgAgent: {} })
  };
  const commonService = {
    httpDelete: jest.fn().mockResolvedValue({ status: 204 }),
    decryptPassword: jest.fn().mockResolvedValue('admin-key')
  };
  const prisma = { $transaction: (run: (tx: unknown) => unknown): unknown => run({}) };
  const service = new AgentServiceService(
    repository as never,
    prisma as never,
    commonService as never,
    null as never,
    null as never,
    null as never,
    { _orgDeletedActivity: jest.fn() } as never,
    null as never
  );
  jest.spyOn(service, 'getOrgAgentApiKey').mockResolvedValue('org-key');
  return { service, repository, commonService };
};

describe('deleteWallet', () => {
  it('deletes the wallet on a dedicated agent, which has no tenant, with the org own key', async () => {
    const { service, repository, commonService } = build(OrgAgentType.DEDICATED, null);

    await service.deleteWallet(ORG_ID, {} as never);

    expect(commonService.httpDelete).toHaveBeenCalledWith(`${ENDPOINT}${CommonConstants.URL_DELETE_WALLET}`, {
      headers: { authorization: 'org-key' }
    });
    expect(repository.platformAdminAgent).not.toHaveBeenCalled();
    expect(repository.deleteOrgAgentByOrg).toHaveBeenCalledWith(ORG_ID);
  });

  it('only removes the row of a shared-agent record that never got a tenant', async () => {
    const { service, repository, commonService } = build(OrgAgentType.SHARED, null);

    await service.deleteWallet(ORG_ID, {} as never);

    expect(repository.deleteOrgAgentByOrg).toHaveBeenCalledWith(ORG_ID);
    expect(commonService.httpDelete).not.toHaveBeenCalled();
  });

  it('deletes a shared-agent tenant with the platform admin key', async () => {
    const { service, commonService } = build(OrgAgentType.SHARED, 'tenant-1');

    await service.deleteWallet(ORG_ID, {} as never);

    expect(commonService.httpDelete).toHaveBeenCalledWith(
      `${ENDPOINT}${CommonConstants.URL_SHAGENT_DELETE_SUB_WALLET}`.replace('#', 'tenant-1'),
      { headers: { authorization: 'admin-key' } }
    );
  });

  it('treats a 404 from the agent as already gone and still removes the org rows', async () => {
    const { service, repository, commonService } = build(OrgAgentType.DEDICATED, null);
    commonService.httpDelete.mockRejectedValue(
      new HttpException({ statusCode: 404, error: 'Not Found' }, HttpStatus.NOT_FOUND)
    );

    await service.deleteWallet(ORG_ID, {} as never);

    expect(repository.deleteOrgAgentByOrg).toHaveBeenCalledWith(ORG_ID);
  });

  it('does not treat a refused connection as already gone', async () => {
    const { service, commonService } = build(OrgAgentType.DEDICATED, null);
    commonService.httpDelete.mockRejectedValue(
      new HttpException({ statusCode: 404, error: 'connect ECONNREFUSED 10.0.0.1:8004' }, HttpStatus.NOT_FOUND)
    );

    await expect(service.deleteWallet(ORG_ID, {} as never)).rejects.toBeDefined();
  });
});
