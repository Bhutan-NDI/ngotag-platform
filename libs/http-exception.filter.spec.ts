/**
 * A microservice answers an uncaught HttpException as an RpcException. The caller must still be able to read the
 * HTTP status and the error code, which is what the 423 ORG_AGENT_MIGRATING freeze depends on.
 */
import { HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { AllExceptionsFilter } from '@credebl/common/exception-handler';
import { CustomExceptionFilter } from 'apps/api-gateway/common/exception-handler';
import { HttpExceptionFilter } from './http-exception.filter';

const FROZEN = new HttpException(
  {
    statusCode: HttpStatus.LOCKED,
    message: 'ORG_AGENT_MIGRATING: the organization agent is being migrated and is temporarily unavailable',
    error: 'ORG_AGENT_MIGRATING'
  },
  HttpStatus.LOCKED
);

describe('HttpExceptionFilter payload', () => {
  const filter = new HttpExceptionFilter();

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterAll(() => jest.restoreAllMocks());

  const emitted = async (exception: unknown): Promise<Record<string, unknown>> => {
    const error = (await firstValueFrom(filter.catch(exception)).catch((e) => e)) as RpcException;
    return error.getError() as Record<string, unknown>;
  };

  it('carries the status, code and message of a 423', async () => {
    expect(await emitted(FROZEN)).toEqual({
      statusCode: 423,
      code: 423,
      error: 'ORG_AGENT_MIGRATING',
      message: 'ORG_AGENT_MIGRATING: the organization agent is being migrated and is temporarily unavailable'
    });
  });

  it('keeps the status, code and message of a subclass such as NotFoundException', async () => {
    expect(await emitted(new NotFoundException('missing'))).toMatchObject({
      statusCode: 404,
      code: 404,
      message: 'missing'
    });
  });

  it('keeps code and message for an exception whose body is a plain string', async () => {
    expect(await emitted(new HttpException('already exists', HttpStatus.CONFLICT))).toEqual({
      statusCode: 409,
      code: 409,
      message: 'already exists'
    });
  });

  it('answers 500 for a non-HTTP error, with the status in both fields', async () => {
    expect(await emitted(new Error('boom'))).toMatchObject({ statusCode: 500, code: 500 });
  });
});

describe('a freeze reaching the API gateway through each of its filters', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterAll(() => jest.restoreAllMocks());

  const rpcPayload = async (): Promise<unknown> => {
    const error = (await firstValueFrom(new HttpExceptionFilter().catch(FROZEN)).catch((e) => e)) as RpcException;
    return error.getError();
  };

  it('answers 423 with the code through the per-controller CustomExceptionFilter', async () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = { switchToHttp: (): object => ({ getResponse: () => response, getRequest: () => ({}) }) };

    new CustomExceptionFilter().catch((await rpcPayload()) as never, host as never);

    expect(response.status).toHaveBeenCalledWith(423);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 423, error: 'ORG_AGENT_MIGRATING' })
    );
  });

  it('answers 423 through the global AllExceptionsFilter', async () => {
    const reply = jest.fn();
    const host = {
      switchToHttp: (): object => ({ getResponse: () => ({}), getRequest: () => ({ method: 'POST', url: '/x' }) })
    };

    new AllExceptionsFilter({ httpAdapter: { reply } } as never).catch((await rpcPayload()) as never, host as never);

    expect(reply).toHaveBeenCalledWith({}, expect.objectContaining({ statusCode: 423 }), 423);
  });
});
