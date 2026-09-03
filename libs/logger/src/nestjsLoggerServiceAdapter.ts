/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConsoleLogger } from '@nestjs/common';
import Logger from '@credebl/logger/logger.interface';
import { LoggerService } from '@nestjs/common/services/logger.service';
import { LogData } from '@credebl/logger/log';

export default class NestjsLoggerServiceAdapter extends ConsoleLogger implements LoggerService {
  public constructor(private readonly logger: Logger) {
    super();
  }

  public info(message: any, ...optionalParams: any[]): void {
    this.logger.info(message, this.getLogData(optionalParams));
  }

  public log(message: any, ...optionalParams: any[]): void {
    this.logger.info(message, this.getLogData(optionalParams));
  }

  public error(message: any, ...optionalParams: any[]): void {
    this.logger.error(message, this.getLogData(optionalParams));
  }

  public warn(message: any, ...optionalParams: any[]): void {
    this.logger.warn(message, this.getLogData(optionalParams));
  }

  public debug(message: any, ...optionalParams: any[]): void {
    this.logger.debug(message, this.getLogData(optionalParams));
  }

  public verbose(message: any, ...optionalParams: any[]): void {
    this.logger.info(message, this.getLogData(optionalParams));
  }

  private getLogData(optionalParams: unknown[]): LogData {
    const params = [...optionalParams];

    // Nest appends the logger's context as the last string argument, not params[0].
    const sourceClass = 'string' === typeof params[params.length - 1] ? (params.pop() as string) : undefined;

    // Surfaced as data.error so winstonLogger can lift its stack.
    const error = params.find((p) => p instanceof Error) as Error | undefined;
    // `undefined` marks an absent argument, not a real value; false/0/null are kept.
    const rest = params.filter((p) => !(p instanceof Error) && undefined !== p);

    return {
      sourceClass,
      ...(error ? { error } : {}),
      ...(0 < rest.length ? { props: { params: rest } } : {})
    };
  }
}
