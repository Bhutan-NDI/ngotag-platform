import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  RpcExceptionFilter,
  Logger
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { normaliseException, resolveHttpStatus, resolveMessage } from './exception-normalisation';
import { Observable, throwError } from 'rxjs';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('CommonService');
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  // Add explicit types for 'exception' and 'host'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  catch(rawException: any, host: ArgumentsHost): void {
    // Same guard as the microservice filter: `exception.constructor` throws on a nullish value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exception = normaliseException(rawException) as any;

    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = '';
    switch (exception.constructor) {
      case HttpException:
        httpStatus = (exception as HttpException).getStatus();
        message = exception?.response?.error || exception?.message || 'Internal server error';
        break;
      case RpcException: {
        const rpcError = exception?.error as { code?: unknown; statusCode?: unknown; status?: unknown };
        httpStatus = resolveHttpStatus(exception?.code, rpcError?.code, rpcError?.statusCode, rpcError?.status);
        // `exception.error` is Nest's stored payload object and is truthy whenever present, so
        // taking it directly put an object into the response `message` and interpolated
        // '[object Object]' into the log line.
        message = resolveMessage(rpcError, exception?.message) ?? 'RpcException';
        break;
      }
      default:
        if ('Rpc Exception' === exception.message) {
          httpStatus = resolveHttpStatus(
            exception?.error?.code,
            exception?.error?.statusCode,
            exception?.error?.status
          );
          message = resolveMessage(exception?.error, exception?.error?.message?.error) ?? 'Internal server error';
        } else {
          // `exception.code` is only a status when it actually is one -- a socket error carries
          // 'ECONNREFUSED' here.
          httpStatus = resolveHttpStatus(
            exception.response?.status,
            exception.response?.statusCode,
            exception.statusCode,
            exception.code
          );
          message =
            resolveMessage(exception.response?.data?.message, exception.response?.message, exception?.message) ??
            'Internal server error';
        }

        if (!this.isHttpErrorStatus(httpStatus)) {
          httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
        }
    }

    // Logged once, here, because this is the only point at which the response status is
    // known -- a 4xx must not land in the error stream. The Error goes as its own argument
    // so the adapter can put it in data.error and winston can lift its stack.
    const level = HttpStatus.INTERNAL_SERVER_ERROR <= httpStatus ? 'error' : 'warn';
    const summary = `${request.method} ${request.url} -> ${httpStatus}: ${message}`;
    // The optional argument is omitted rather than passed as undefined, which would surface as a
    // synthetic `props.params: [null]` in the JSON output.
    if (exception instanceof Error) {
      this.logger[level](summary, exception);
    } else {
      this.logger[level](summary);
    }
    const responseBody = {
      statusCode: httpStatus,
      message,
      error: exception.message
    };
    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }

  isHttpErrorStatus(statusCode: number): boolean {
    return Object.values(HttpStatus).includes(statusCode);
  }
}

@Catch(RpcException)
export class CustomExceptionFilter implements RpcExceptionFilter<RpcException> {
  private readonly logger = new Logger('CommonService');

  // Add explicit types for 'exception' and 'host'
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  catch(exception: RpcException, host: ArgumentsHost): Observable<any> {
    if (exception instanceof Error) {
      this.logger.error(exception.message, exception);
    } else {
      this.logger.error(String(exception));
    }
    return throwError(() => new RpcException({ message: exception.getError(), code: HttpStatus.BAD_REQUEST }));
  }
}
