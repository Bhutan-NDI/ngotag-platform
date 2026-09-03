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

import { AgentServiceController } from './agent-service.controller';
import { AgentServiceService } from './agent-service.service';
import { CommonConstants } from '@credebl/common/common.constant';
import { ISetDedicatedAgentToken } from './interface/agent-service.interface';
import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

const DEDICATED_TYPE_ID = 'dedicated-type-id';
const SHARED_TYPE_ID = 'shared-type-id';
const AGENT_ENDPOINT = 'https://agent.example.com';
const TARGET_ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';

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
): { service: AgentServiceService; updateVerifiedTenantToken: jest.Mock; httpGet: jest.Mock } => {
  const updateVerifiedTenantToken = jest.fn().mockResolvedValue(undefined);
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
    updateVerifiedTenantToken
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

  return { service, updateVerifiedTenantToken, httpGet };
};

const payloadFor = (agentToken: string): ISetDedicatedAgentToken => ({
  targetOrgId: TARGET_ORG_ID,
  agentToken,
  agentEndPoint: AGENT_ENDPOINT,
  userId: USER_ID
});

const call = (svc: AgentServiceService, tok: string): Promise<unknown> => svc.setDedicatedAgentToken(payloadFor(tok));

const messageOf = (error: unknown): string => {
  const payload = (error as RpcException)?.getError?.();
  return 'string' === typeof payload ? payload : ((payload as { message?: string })?.message ?? '');
};

describe('setDedicatedAgentToken - role gate', () => {
  it('refuses a tenant token for the base wallet, and never reaches the agent or the database', async () => {
    const { service, updateVerifiedTenantToken, httpGet } = buildService({
      orgName: String(CommonConstants.PLATFORM_ADMIN_ORG)
    });

    await expect(call(service, tokenFor(AgentRole.RestTenantAgent))).rejects.toThrow(RpcException);

    expect(httpGet).not.toHaveBeenCalled();
    expect(updateVerifiedTenantToken).not.toHaveBeenCalled();
  });

  it('names the role it expected, so the operator can tell which token to mint', async () => {
    const { service } = buildService({ orgName: String(CommonConstants.PLATFORM_ADMIN_ORG) });

    const error = await call(service, tokenFor(AgentRole.RestTenantAgent)).catch((e) => e);
    expect(messageOf(error)).toContain(AgentRole.RestRootAgentWithTenants);
  });

  it('refuses a dedicated-agent token for the base wallet', async () => {
    const { service, updateVerifiedTenantToken } = buildService({
      orgName: String(CommonConstants.PLATFORM_ADMIN_ORG)
    });

    await expect(call(service, tokenFor(AgentRole.RestRootAgent))).rejects.toThrow(RpcException);
    expect(updateVerifiedTenantToken).not.toHaveBeenCalled();
  });

  it('refuses a base-wallet token for an ordinary dedicated org', async () => {
    const { service, updateVerifiedTenantToken } = buildService();

    await expect(call(service, tokenFor(AgentRole.RestRootAgentWithTenants))).rejects.toThrow(RpcException);
    expect(updateVerifiedTenantToken).not.toHaveBeenCalled();
  });

  it('refuses a token with no role claim', async () => {
    const { service, updateVerifiedTenantToken } = buildService();

    await expect(call(service, jwt.sign({ agentInfo: 'agentInfo' }, 'irrelevant'))).rejects.toThrow(RpcException);
    expect(updateVerifiedTenantToken).not.toHaveBeenCalled();
  });

  it('accepts the matching role for the base wallet and persists it', async () => {
    const { service, updateVerifiedTenantToken, httpGet } = buildService({
      orgName: String(CommonConstants.PLATFORM_ADMIN_ORG)
    });

    const result = await call(service, tokenFor(AgentRole.RestRootAgentWithTenants));

    expect(httpGet).toHaveBeenCalled();
    expect(updateVerifiedTenantToken).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ orgId: TARGET_ORG_ID, role: AgentRole.RestRootAgentWithTenants }));
  });

  it('accepts the matching role for an ordinary dedicated org', async () => {
    const { service, updateVerifiedTenantToken } = buildService();

    await call(service, tokenFor(AgentRole.RestRootAgent));

    expect(updateVerifiedTenantToken).toHaveBeenCalledTimes(1);
  });

  it('refuses a SHARED org outright, since those self-heal', async () => {
    const { service, updateVerifiedTenantToken, httpGet } = buildService({ orgAgentTypeId: SHARED_TYPE_ID });

    await expect(call(service, tokenFor(AgentRole.RestRootAgent))).rejects.toThrow(RpcException);
    expect(httpGet).not.toHaveBeenCalled();
    expect(updateVerifiedTenantToken).not.toHaveBeenCalled();
  });

  it('writes the token as a compare-and-set keyed on the row it was verified against, attributed to the caller', async () => {
    const { service, updateVerifiedTenantToken } = buildService();

    await call(service, tokenFor(AgentRole.RestRootAgent));

    expect(updateVerifiedTenantToken).toHaveBeenCalledWith(
      TARGET_ORG_ID,
      AGENT_ENDPOINT,
      DEDICATED_TYPE_ID,
      expect.any(String),
      USER_ID
    );
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

describe('setDedicatedAgentToken - via the @MessagePattern handler', () => {
  it('preserves the RpcException status/message across the controller for a refused SHARED org', async () => {
    const { service } = buildService({ orgAgentTypeId: SHARED_TYPE_ID });
    const controller = new AgentServiceController(service);

    const error = await controller
      .setDedicatedAgentToken({
        setDedicatedAgentTokenDto: {
          targetOrgId: TARGET_ORG_ID,
          agentToken: tokenFor(AgentRole.RestRootAgent),
          agentEndPoint: AGENT_ENDPOINT
        },
        userId: USER_ID
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(RpcException);
    const payload = error.getError() as { statusCode?: number; message?: string };
    expect(payload.statusCode).toBe(400);
    expect(payload.message).toContain('dedicated agent');
  });

  it('threads userId from the NATS payload into the repository write', async () => {
    const { service, updateVerifiedTenantToken } = buildService();
    const controller = new AgentServiceController(service);

    await controller.setDedicatedAgentToken({
      setDedicatedAgentTokenDto: {
        targetOrgId: TARGET_ORG_ID,
        agentToken: tokenFor(AgentRole.RestRootAgent),
        agentEndPoint: AGENT_ENDPOINT
      },
      userId: USER_ID
    });

    expect(updateVerifiedTenantToken).toHaveBeenCalledWith(
      TARGET_ORG_ID,
      AGENT_ENDPOINT,
      DEDICATED_TYPE_ID,
      expect.any(String),
      USER_ID
    );
  });
});
