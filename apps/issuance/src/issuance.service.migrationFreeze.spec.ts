/**
 * The migration freeze answers 423 ORG_AGENT_MIGRATING. That answer must reach an issuance caller with its status
 * and code instead of turning into a 400 whose per-connection rows hide it.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { IssueCredentialType } from '@credebl/enum/enum';
import { IssuanceService } from './issuance.service';

jest.mock('socket.io-client', () => ({ io: jest.fn(() => ({ emit: jest.fn() })) }));
jest.mock('cache-manager-ioredis-yet', () => ({
  redisStore: jest.fn(async () => ({ del: jest.fn().mockResolvedValue(undefined) }))
}));

const FROZEN = {
  message: 'ORG_AGENT_MIGRATING: the organization agent is being migrated and is temporarily unavailable',
  code: 423,
  statusCode: 423,
  error: 'ORG_AGENT_MIGRATING'
};

const offer = (connectionIds: string[]): never =>
  ({
    orgId: 'org',
    credentialType: IssueCredentialType.INDY,
    credentialDefinitionId: 'definition',
    comment: 'synthetic',
    credentialData: connectionIds.map((connectionId) => ({
      connectionId,
      attributes: [{ name: 'name', value: 'synthetic' }]
    }))
  }) as never;

const fixture = (): { service: IssuanceService; send: jest.Mock } => {
  const send = jest.fn();
  const repository = {
    getCredentialDefinitionDetails: jest.fn().mockResolvedValue({ attributes: '[]' }),
    getAgentEndPoint: jest
      .fn()
      .mockResolvedValue({ agentEndPoint: 'https://agent.example.com', orgAgentTypeId: 'shared' }),
    getOrgAgentType: jest.fn().mockResolvedValue({})
  };
  const coordinator = { offerConcurrency: 2, offer: jest.fn((operation: () => Promise<unknown>) => operation()) };
  const service = new IssuanceService(
    {} as never,
    {} as never,
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { send } as never,
    {} as never,
    coordinator as never
  );
  return { service, send };
};

const call = (service: IssuanceService): Promise<unknown> =>
  service.natsCallAgent({ cmd: 'agent-send-credential-create-offer' } as never, {} as never);

describe('issuance: rewrapping an error from the agent service', () => {
  it('keeps the 423 status and the ORG_AGENT_MIGRATING code', async () => {
    const { service, send } = fixture();
    send.mockRejectedValue(FROZEN);

    const error = (await call(service).catch((e) => e)) as HttpException;

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.LOCKED);
    expect(error.getResponse()).toEqual({ statusCode: 423, message: FROZEN.message, error: 'ORG_AGENT_MIGRATING' });
  });

  it('keeps the status and error name of an ordinary forwarded exception', async () => {
    const { service, send } = fixture();
    send.mockRejectedValue({ statusCode: 404, message: 'Connection not found', error: 'Not Found' });

    const error = (await call(service).catch((e) => e)) as HttpException;

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({ statusCode: 404, message: 'Connection not found', error: 'Not Found' });
  });

  it('reads the status from code when that is all the error carries', async () => {
    const { service, send } = fixture();
    send.mockRejectedValue({ message: 'bad input', code: 400 });

    const error = (await call(service).catch((e) => e)) as HttpException;

    expect(error.getStatus()).toBe(400);
  });

  it('falls back to 500, never to an undefined status, when the error has no status at all', async () => {
    const { service, send } = fixture();
    send.mockRejectedValue({ message: 'something broke' });

    const error = (await call(service).catch((e) => e)) as HttpException;

    expect(error.getStatus()).toBe(500);
  });
});

describe('issuance: credential offer while the org is migrating', () => {
  it('answers a top-level 423 when every connection is refused for the freeze', async () => {
    const { service, send } = fixture();
    send.mockRejectedValue(FROZEN);

    const error = (await service.sendCredentialCreateOffer(offer(['c1', 'c2'])).catch((e) => e)) as RpcException;

    expect(error).toBeInstanceOf(RpcException);
    expect(error.getError()).toEqual({ statusCode: 423, message: FROZEN.message, error: 'ORG_AGENT_MIGRATING' });
  });

  it('keeps the partial result when only some connections were refused', async () => {
    const { service, send } = fixture();
    send.mockResolvedValueOnce({ threadId: 't1' }).mockRejectedValueOnce(FROZEN);

    const result = (await service.sendCredentialCreateOffer(offer(['c1', 'c2']))) as {
      statusCode: number;
      data: { statusCode: number; error?: string }[];
    };

    expect(result.statusCode).toBe(HttpStatus.PARTIAL_CONTENT);
    expect(result.data[0].statusCode).toBe(HttpStatus.CREATED);
    expect(result.data[1]).toMatchObject({ statusCode: 423, error: 'ORG_AGENT_MIGRATING' });
  });

  it('still answers 400 with rows when every connection fails for another reason', async () => {
    const { service, send } = fixture();
    send.mockRejectedValue({ statusCode: 400, message: 'Connection is not ready', error: 'Bad Request' });

    const result = (await service.sendCredentialCreateOffer(offer(['c1', 'c2']))) as {
      statusCode: number;
      data: unknown[];
    };

    expect(result.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(result.data).toHaveLength(2);
  });
});
