/**
 * Regression coverage for the shared logging contract used by every microservice: classify
 * before logging, derive the level from the resolved status, and never emit a synthetic log
 * param. Assertions run against the real Winston format chain rather than a stub, since these
 * defects only show up in the serialised output.
 */
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { RpcException } from '@nestjs/microservices';
import { Writable } from 'stream';
import * as ecsFormat from '@elastic/ecs-winston-format';
import * as winston from 'winston';

import { AllExceptionsFilter } from '../../../common/src/exception-handler';
import { CustomExceptionFilter } from '../../../../apps/api-gateway/common/exception-handler';
import { HttpExceptionFilter } from '../../../http-exception.filter';
import { LogLevel } from '../log';
import NestjsLoggerServiceAdapter from '../nestjsLoggerServiceAdapter';

/** Mirrors winstonLogger.ts's format chain, including the guarded label. */
function buildWinston(sink: string[]): winston.Logger {
  const levels: Record<string, number> = {};
  let index = 0;
  Object.values(LogLevel).forEach((level) => {
    levels[level] = index++;
  });

  return winston.createLogger({
    level: 'debug',
    levels,
    format: winston.format.combine(
      ecsFormat.ecsFormat({ convertReqRes: true }),
      winston.format.errors({ stack: true }),
      winston.format((info) => {
        if (info.error && info.error instanceof Error) {
          info.stack = info.error.stack;
          info.error = undefined;
        }
        info.label = [info.organization, info.context, info.app].filter(Boolean).join('.') || undefined;
        return info;
      })(),
      winston.format.metadata({ key: 'data', fillExcept: ['timestamp', 'level', 'message'] }),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Stream({
        stream: new Writable({
          write(chunk, _encoding, callback): void {
            sink.push(chunk.toString().trim());
            callback();
          }
        })
      })
    ]
  });
}

type Emitted = { level: string; message: string | Error; data?: Record<string, unknown> };

/** Stands in for LoggerService: records what the adapter passes on, and renders it via Winston. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function buildLoggerBase(emitted: Emitted[], sink: string[]) {
  const wire = buildWinston(sink);
  function record(level: string): (message: string | Error, data?: Record<string, unknown>) => void {
    return (message, data) => {
      emitted.push({ level, message, data });
      wire.log({ level, message: message instanceof Error ? message.message : message, ...data });
    };
  }

  return {
    log: (level: string, message: string | Error, data?: Record<string, unknown>): void => record(level)(message, data),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    emergency: record('emergency'),
    startProfile: (): void => {}
  };
}

describe('nestjsLoggerServiceAdapter', () => {
  let emitted: Emitted[];
  let sink: string[];

  beforeEach(() => {
    emitted = [];
    sink = [];
    Logger.overrideLogger(new NestjsLoggerServiceAdapter(buildLoggerBase(emitted, sink) as never));
  });

  it('emits one record with the right sourceClass and the stack, for Logger.error(message, Error)', () => {
    function failingCallSite(): never {
      throw new Error('Askar: wallet not found');
    }
    let caught: Error;
    try {
      failingCallSite();
    } catch (error) {
      caught = error as Error;
    }

    new Logger('CommonService').error(caught!.message, caught!);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data?.sourceClass).toBe('CommonService');
    expect(emitted[0].data?.error).toBe(caught!);

    const record = JSON.parse(sink[0]) as { data: Record<string, unknown> };
    expect(String(record.data.stack)).toContain('failingCallSite');
  });

  it('does not emit props.params: [null] when the optional argument is absent', () => {
    new Logger('CommonService').error('plain message');

    expect(emitted[0].data?.props).toBeUndefined();
    expect(sink[0]).not.toContain('"params":[null]');
  });

  it('does not emit props.params: [null] when undefined is passed explicitly', () => {
    // Mirrors passing an explicit undefined, as the exception filters used to.
    (new Logger('CommonService').error as (m: string, ...rest: unknown[]) => void)('plain message', undefined);

    expect(emitted[0].data?.sourceClass).toBe('CommonService');
    expect(emitted[0].data?.props).toBeUndefined();
    expect(sink[0]).not.toContain('"params":[null]');
  });

  it('keeps meaningful falsy parameters', () => {
    (new Logger('CommonService').error as (m: string, ...rest: unknown[]) => void)('plain message', 0, false, null);

    expect(emitted[0].data?.props).toEqual({ params: [0, false, null] });
  });

  it('omits the label entirely when ORGANIZATION/CONTEXT/APP are unset', () => {
    new Logger('CommonService').error('plain message');

    const record = JSON.parse(sink[0]) as { data: Record<string, unknown> };
    expect(record.data.label).toBeUndefined();
    expect(sink[0]).not.toContain('undefined.undefined.undefined');
  });
});

describe('HttpExceptionFilter (all microservices)', () => {
  let emitted: Emitted[];
  let sink: string[];
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    emitted = [];
    sink = [];
    Logger.overrideLogger(new NestjsLoggerServiceAdapter(buildLoggerBase(emitted, sink) as never));
    filter = new HttpExceptionFilter();
  });

  function swallow(observable: ReturnType<HttpExceptionFilter['catch']>): void {
    observable.subscribe({ error: () => {}, next: () => {} });
  }

  it('logs an HttpException 404 at warn, not error', () => {
    swallow(filter.catch(new HttpException('missing', HttpStatus.NOT_FOUND)));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('warn');
    expect(String(emitted[0].message)).toContain('404');
  });

  it('logs a Prisma P2025 at warn — it resolves to 404', () => {
    const prismaError = new PrismaClientKnownRequestError('No record was found', {
      code: 'P2025',
      clientVersion: 'test'
    });
    swallow(filter.catch(prismaError));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('warn');
  });

  it('logs a 500 at error', () => {
    swallow(filter.catch(new Error('boom')));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('error');
    expect(emitted[0].data?.error).toBeInstanceOf(Error);
  });

  it('emits exactly once on the RpcException forwarding path', () => {
    swallow(filter.catch(new RpcException({ message: 'upstream failed', code: 400 })));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('warn');
  });

  it('keeps a useful message for a structured non-Error exception', () => {
    swallow(filter.catch({ response: { statusCode: 400, message: 'tenant already exists' } }));

    expect(emitted).toHaveLength(1);
    expect(String(emitted[0].message)).toContain('tenant already exists');
    expect(String(emitted[0].message)).not.toContain('[object Object]');
    // No Error to attach, so no synthetic parameter either.
    expect(emitted[0].data?.props).toBeUndefined();
  });

  it('resolves an RpcException status from statusCode, as connection and ecosystem raise it', () => {
    swallow(filter.catch(new RpcException({ message: 'already exists', statusCode: HttpStatus.CONFLICT })));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('warn');
    expect(String(emitted[0].message)).toContain('409');
  });

  it('resolves an RpcException status from status', () => {
    swallow(filter.catch(new RpcException({ message: 'bad input', status: HttpStatus.BAD_REQUEST })));

    expect(emitted[0].level).toBe('warn');
    expect(String(emitted[0].message)).toContain('400');
  });

  it('does not treat a non-HTTP Error.code as a status', () => {
    const socketError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    swallow(filter.catch(socketError));

    // A downstream outage must read as a 500 error, not a warn carrying a string status.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('error');
    expect(String(emitted[0].message)).toContain('500');
  });

  it('rejects a non-error RpcException status (200) and falls back to 500', () => {
    // A stray 200 must not turn a caught exception into a reported success.
    swallow(filter.catch(new RpcException({ message: 'ok?', code: 200 })));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('error');
    expect(String(emitted[0].message)).toContain('500');
  });

  it('rejects a direct HttpException status (200) and falls back to 500', () => {
    // The RpcException case above doesn't exercise the HttpException branch's own status read.
    let forwarded: RpcException;
    filter.catch(new HttpException('done?', HttpStatus.OK)).subscribe({ error: (e) => (forwarded = e) });

    expect(emitted[0].level).toBe('error');
    expect((forwarded!.getError() as { code: number }).code).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('retains a { statusCode, error } envelope message rather than losing it', () => {
    // CommonService.sendError throws exactly this shape, with no `message` field at all.
    let forwarded: RpcException;
    filter
      .catch(new HttpException({ statusCode: 503, error: 'agent unreachable' }, 503))
      .subscribe({ error: (e) => (forwarded = e) });

    expect((forwarded!.getError() as { message: string }).message).toBe('agent unreachable');
    expect(String(emitted[0].message)).toContain('agent unreachable');
  });

  it('handles a null rejection without throwing', () => {
    expect(() => swallow(filter.catch(null))).not.toThrow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('error');
  });

  it('handles an undefined rejection without throwing', () => {
    expect(() => swallow(filter.catch(undefined))).not.toThrow();
    expect(emitted).toHaveLength(1);
  });

  it('handles a string rejection without leaking its contents', () => {
    swallow(filter.catch('upstream said SENTINEL_TOKEN'));

    expect(emitted).toHaveLength(1);
    expect(JSON.stringify(emitted[0])).not.toContain('SENTINEL_TOKEN');
    expect(String(emitted[0].message)).toContain('(string)');
  });

  it('never emits caught error: {} for a real Error', () => {
    swallow(filter.catch(new Error('Askar: wallet not found')));

    expect(sink[0]).not.toContain('caught error: {}');
    expect(sink[0]).toContain('Askar: wallet not found');
  });
});

describe('AllExceptionsFilter (API Gateway, global)', () => {
  let emitted: Emitted[];
  let sink: string[];
  let filter: AllExceptionsFilter;
  let replied: { status?: number; body?: Record<string, unknown> };

  beforeEach(() => {
    emitted = [];
    sink = [];
    replied = {};
    Logger.overrideLogger(new NestjsLoggerServiceAdapter(buildLoggerBase(emitted, sink) as never));
    const httpAdapterHost = {
      httpAdapter: {
        reply: (_res: unknown, body: Record<string, unknown>, status: number): void => {
          replied = { status, body };
        }
      }
    };
    filter = new AllExceptionsFilter(httpAdapterHost as never);
  });

  function host(): unknown {
    return { switchToHttp: () => ({ getRequest: () => ({ method: 'POST', url: '/orgs' }), getResponse: () => ({}) }) };
  }

  it('keeps the RpcException message a string rather than [object Object]', () => {
    filter.catch(new RpcException({ message: 'tenant missing', code: HttpStatus.NOT_FOUND }), host() as never);

    expect(String(emitted[0].message)).toContain('tenant missing');
    expect(String(emitted[0].message)).not.toContain('[object Object]');
    expect(typeof replied.body?.message).toBe('string');
  });

  it('logs a 404 RpcException at warn', () => {
    filter.catch(new RpcException({ message: 'tenant missing', statusCode: HttpStatus.NOT_FOUND }), host() as never);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('warn');
  });

  it('handles a null rejection without throwing', () => {
    expect(() => filter.catch(null, host() as never)).not.toThrow();
    expect(emitted).toHaveLength(1);
    expect(replied.status).toBe(500);
  });

  it('rejects a non-error RpcException status (302) and falls back to 500', () => {
    filter.catch(new RpcException({ message: 'redirect?', code: 302 }), host() as never);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].level).toBe('error');
    expect(replied.status).toBe(500);
  });

  it('rejects a direct HttpException status (200) and falls back to 500', () => {
    filter.catch(new HttpException('done?', HttpStatus.OK), host() as never);

    expect(emitted[0].level).toBe('error');
    expect(replied.status).toBe(500);
  });

  it('carries a { statusCode, error } envelope across a microservice hop rather than losing it', () => {
    // Mirrors the real path: HttpExceptionFilter (microservice) forwards CommonService.sendError's
    // exception, and AllExceptionsFilter (Gateway) is what the client's response is built from.
    const microserviceFilter = new HttpExceptionFilter();
    let forwarded: RpcException;
    microserviceFilter
      .catch(new HttpException({ statusCode: 503, error: 'agent unreachable' }, 503))
      .subscribe({ error: (e) => (forwarded = e) });

    // What actually crosses NATS is the plain payload the microservice's RpcException carried,
    // re-wrapped as a fresh RpcException on the Gateway side -- not the instance itself.
    filter.catch(new RpcException(forwarded!.getError()), host() as never);

    expect(String(emitted[emitted.length - 1].message)).toContain('agent unreachable');
    expect(replied.body?.message).toBe('agent unreachable');
  });
});

describe('CustomExceptionFilter (API Gateway, controller-scoped)', () => {
  let emitted: Emitted[];
  let sink: string[];
  let filter: CustomExceptionFilter;
  let replied: { status?: number; body?: Record<string, unknown> };

  beforeEach(() => {
    emitted = [];
    sink = [];
    replied = {};
    Logger.overrideLogger(new NestjsLoggerServiceAdapter(buildLoggerBase(emitted, sink) as never));
    filter = new CustomExceptionFilter();
  });

  function host(): unknown {
    const response = {
      status(code: number): unknown {
        replied.status = code;
        return this;
      },
      json(body: Record<string, unknown>): unknown {
        replied.body = body;
        return this;
      }
    };
    return { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }) };
  }

  it('emits exactly one record for a controller exception — it used to emit none', () => {
    filter.catch(new HttpException('org not found', HttpStatus.NOT_FOUND), host() as never);

    expect(emitted).toHaveLength(1);
    expect(replied.status).toBe(HttpStatus.NOT_FOUND);
  });

  it('logs a 404 at warn and a 500 at error', () => {
    filter.catch(new HttpException('org not found', HttpStatus.NOT_FOUND), host() as never);
    expect(emitted[0].level).toBe('warn');

    emitted.length = 0;
    filter.catch(new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR), host() as never);
    expect(emitted[0].level).toBe('error');
  });

  it('handles a null rejection without throwing', () => {
    expect(() => filter.catch(null as never, host() as never)).not.toThrow();
    expect(emitted).toHaveLength(1);
  });

  it('handles a circular rejection without throwing', () => {
    // The empty-payload check used to run exception through JSON.stringify unguarded.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => filter.catch(circular as never, host() as never)).not.toThrow();
    expect(replied.status).toBeDefined();
  });

  it('rejects a non-error statusCode (200) and falls back to 500', () => {
    // A malformed 2xx status must not turn a caught exception into a reported success.
    filter.catch(new HttpException({ statusCode: 200, message: 'ok?' }, 200), host() as never);

    expect(replied.status).toBe(500);
    expect(replied.body?.statusCode).toBe(500);
    expect(emitted[0].level).toBe('error');
  });

  it('normalizes a structured message instead of throwing on .includes', () => {
    // { message: { error } } used to crash exceptionResponse.message.includes().
    const structured = new HttpException({ statusCode: 400, message: { error: 'nested failure' } }, 400);

    expect(() => filter.catch(structured, host() as never)).not.toThrow();

    expect(emitted).toHaveLength(1);
    expect(replied.status).toBe(400);
    expect(typeof replied.body?.message).toBe('string');
  });

  it('preserves a validation-error array message', () => {
    filter.catch(new HttpException({ statusCode: 400, message: ['name must not be empty'] }, 400), host() as never);

    expect(replied.body?.message).toEqual(['name must not be empty']);
  });

  it('validates a numeric-string statusCode consistently across the log, body, and response.status()', () => {
    filter.catch(new HttpException({ statusCode: '404', message: 'missing' }, 404), host() as never);

    expect(replied.status).toBe(404);
    expect(replied.body?.statusCode).toBe(404);
    expect(String(emitted[0].message)).toContain('404');
  });
});
