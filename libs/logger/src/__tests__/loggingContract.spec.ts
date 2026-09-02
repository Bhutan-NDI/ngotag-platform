/**
 * Regression coverage for the shared logging contract. `nestjsLoggerServiceAdapter` and the two
 * exception filters are wired into every one of the nineteen apps, so a defect here is a defect
 * everywhere at once — which is how both of the review findings this file locks down reached the
 * branch in the first place:
 *
 *   1. The microservice filter logged before the status was resolved, so an HttpException 404 and
 *      a Prisma P2025 both landed at `error` level.
 *   2. The adapter kept an absent optional argument, emitting a synthetic `props.params: [null]`.
 *
 * Assertions run against the real Winston format chain rather than a stub, because the defects
 * were only visible in the serialised output.
 */
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { RpcException } from '@nestjs/microservices';
import { Writable } from 'stream';
import * as ecsFormat from '@elastic/ecs-winston-format';
import * as winston from 'winston';

import { HttpExceptionFilter } from '../../../http-exception.filter';
import { LogLevel } from '../log';
import NestjsLoggerServiceAdapter from '../nestjsLoggerServiceAdapter';

/** Mirrors winstonLogger.ts's format chain, including the guarded label from this PR. */
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
    // The shape the exception filters used before this PR restructured them.
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

  it('never emits caught error: {} for a real Error', () => {
    swallow(filter.catch(new Error('Askar: wallet not found')));

    expect(sink[0]).not.toContain('caught error: {}');
    expect(sink[0]).toContain('Askar: wallet not found');
  });
});
