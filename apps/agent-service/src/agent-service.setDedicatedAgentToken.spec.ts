/**
 * Regression cover for setDedicatedAgentToken's role gate.
 *
 * GET /agent accepts the tenant, dedicated and Basewallet scopes alike, so a live probe on its own
 * would let a RestTenantAgent token be stored against the platform-admin (base wallet) row. Every
 * SHARED org self-heal authenticates with that row's token against Basewallet-only tenant routes, so
 * the whole shared fleet would then 401 with the repair endpoint reporting success.
 *
 * Note this repo has no jest step in CI - run with:
 *   npx jest apps/agent-service/src/agent-service.setDedicatedAgentToken.spec.ts
 */
import * as jwt from 'jsonwebtoken';

import { AgentRole, OrgAgentType } from '@credebl/enum/enum';

import { AgentServiceService } from './agent-service.service';
import { CommonConstants } from '@credebl/common/common.constant';
import { ISetDedicatedAgentToken } from './interface/agent-service.interface';
import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

const DEDICATED_TYPE_ID = 'dedicated-type-id';
const SHARED_TYPE_ID = 'shared-type-id';
const AGENT_ENDPOINT = 'https://agent.example.com';
const TARGET_ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const tokenFor = (role: AgentRole): string => jwt.sign({ role }, 'irrelevant-to-decode');

interface Overrides {
  orgName?: string;
  orgAgentTypeId?: string;
  isInitialized?: boolean;
  // Lets a test simulate the agent probe rejecting (e.g. a 401), instead of resolving.
  probeRejection?: unknown;
}

const buildService = (
  overrides: Overrides = {}
): { service: AgentServiceService; updateTenantToken: jest.Mock; httpGet: jest.Mock } => {
  const updateTenantToken = jest.fn().mockResolvedValue({});
  const httpGet = jest
    .fn()
    .mockReturnValue(
      overrides.probeRejection
        ? { toPromise: () => Promise.reject(overrides.probeRejection) }
        : { toPromise: () => Promise.resolve({ data: { isInitialized: overrides.isInitialized ?? true } }) }
    );

  const repository = {
    getAgentApiKey: jest.fn().mockResolvedValue({
      orgAgentTypeId: overrides.orgAgentTypeId ?? DEDICATED_TYPE_ID,
      agentEndPoint: AGENT_ENDPOINT
    }),
    getOrgAgentTypeDetails: jest.fn().mockImplementation(async (agentType: string) => {
      expect(agentType).toBe(OrgAgentType.DEDICATED);
      return DEDICATED_TYPE_ID;
    }),
    getOrgDetails: jest.fn().mockResolvedValue({ name: overrides.orgName ?? 'Some Customer Org' }),
    updateTenantToken
  };

  process.env.CRYPTO_PRIVATE_KEY = 'test-crypto-private-key';

  const service = new AgentServiceService(
    repository as never,
    null as never,
    null as never,
    { get: httpGet } as never,
    null as never,
    null as never,
    null as never,
    null as never
  );

  return { service, updateTenantToken, httpGet };
};

const payloadFor = (agentToken: string): ISetDedicatedAgentToken => ({
  targetOrgId: TARGET_ORG_ID,
  agentToken,
  agentEndPoint: AGENT_ENDPOINT
});

const call = (svc: AgentServiceService, tok: string): Promise<unknown> => svc.setDedicatedAgentToken(payloadFor(tok));

const messageOf = (error: unknown): string => {
  const payload = (error as RpcException)?.getError?.();
  return 'string' === typeof payload ? payload : ((payload as { message?: string })?.message ?? '');
};

describe('setDedicatedAgentToken - role gate', () => {
  it('refuses a tenant token for the base wallet, and never reaches the agent or the database', async () => {
    const { service, updateTenantToken, httpGet } = buildService({
      orgName: String(CommonConstants.PLATFORM_ADMIN_ORG)
    });

    await expect(call(service, tokenFor(AgentRole.RestTenantAgent))).rejects.toThrow(RpcException);

    expect(httpGet).not.toHaveBeenCalled();
    expect(updateTenantToken).not.toHaveBeenCalled();
  });

  it('names the role it expected, so the operator can tell which token to mint', async () => {
    const { service } = buildService({ orgName: String(CommonConstants.PLATFORM_ADMIN_ORG) });

    const error = await call(service, tokenFor(AgentRole.RestTenantAgent)).catch((e) => e);
    expect(messageOf(error)).toContain(AgentRole.RestRootAgentWithTenants);
  });

  it('refuses a dedicated-agent token for the base wallet', async () => {
    const { service, updateTenantToken } = buildService({ orgName: String(CommonConstants.PLATFORM_ADMIN_ORG) });

    await expect(call(service, tokenFor(AgentRole.RestRootAgent))).rejects.toThrow(RpcException);
    expect(updateTenantToken).not.toHaveBeenCalled();
  });

  it('refuses a base-wallet token for an ordinary dedicated org', async () => {
    const { service, updateTenantToken } = buildService();

    await expect(call(service, tokenFor(AgentRole.RestRootAgentWithTenants))).rejects.toThrow(RpcException);
    expect(updateTenantToken).not.toHaveBeenCalled();
  });

  it('refuses a token with no role claim', async () => {
    const { service, updateTenantToken } = buildService();

    await expect(call(service, jwt.sign({ agentInfo: 'agentInfo' }, 'irrelevant'))).rejects.toThrow(RpcException);
    expect(updateTenantToken).not.toHaveBeenCalled();
  });

  it('accepts the matching role for the base wallet and persists it', async () => {
    const { service, updateTenantToken, httpGet } = buildService({
      orgName: String(CommonConstants.PLATFORM_ADMIN_ORG)
    });

    const result = await call(service, tokenFor(AgentRole.RestRootAgentWithTenants));

    expect(httpGet).toHaveBeenCalled();
    expect(updateTenantToken).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ orgId: TARGET_ORG_ID, role: AgentRole.RestRootAgentWithTenants }));
  });

  it('accepts the matching role for an ordinary dedicated org', async () => {
    const { service, updateTenantToken } = buildService();

    await call(service, tokenFor(AgentRole.RestRootAgent));

    expect(updateTenantToken).toHaveBeenCalledTimes(1);
  });

  it('refuses a SHARED org outright, since those self-heal', async () => {
    const { service, updateTenantToken, httpGet } = buildService({ orgAgentTypeId: SHARED_TYPE_ID });

    await expect(call(service, tokenFor(AgentRole.RestRootAgent))).rejects.toThrow(RpcException);
    expect(httpGet).not.toHaveBeenCalled();
    expect(updateTenantToken).not.toHaveBeenCalled();
  });
});

describe('setDedicatedAgentToken - rejected-probe logging', () => {
  it('never writes the submitted token into logs, even on a rejected (401) probe', async () => {
    const sentinelToken = tokenFor(AgentRole.RestRootAgent);
    // Shaped like the AxiosError a real 401 response produces: carries the request headers
    // (including the token under test) on `config`, the way AxiosError.toJSON() would serialise it.
    const axiosLikeRejection = {
      message: 'Request failed with status code 401',
      response: { status: 401 },
      config: { headers: { authorization: sentinelToken } },
      toJSON: (): unknown => ({
        message: 'Request failed with status code 401',
        config: { headers: { authorization: sentinelToken } }
      })
    };
    const { service } = buildService({ probeRejection: axiosLikeRejection });
    const logSpy = jest.spyOn(Logger.prototype, 'error');

    await call(service, sentinelToken).catch(() => undefined);

    const loggedText = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(loggedText).not.toContain(sentinelToken);

    logSpy.mockRestore();
  });
});
