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
import { Observable, throwError } from 'rxjs';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('CommonService');
  constructor(private readonly httpAdapterHost: HttpAdapterHost) { }

  // Add explicit types for 'exception' and 'host'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  catch(exception: any, host: ArgumentsHost): void {

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
      case RpcException:
        httpStatus = exception?.code || exception?.error?.code || HttpStatus.INTERNAL_SERVER_ERROR;
        message = exception?.error || exception?.error?.message?.error || 'RpcException';
        break;
      default:
        if ('Rpc Exception' === exception.message) {
          httpStatus = exception?.error?.code || HttpStatus.INTERNAL_SERVER_ERROR;
          message = exception?.error?.message?.error || 'Internal server error';
        } else {
          httpStatus =
          exception.response?.status ||
          exception.response?.statusCode ||
          exception.code ||
          exception.statusCode ||
          HttpStatus.INTERNAL_SERVER_ERROR;
        message =
          exception.response?.data?.message ||
          exception.response?.message ||
          exception?.message ||
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
    this.logger[level](
      `${request.method} ${request.url} -> ${httpStatus}: ${message}`,
      exception instanceof Error ? exception : undefined
    );
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
    this.logger.error(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception : undefined
    );
    return throwError(() => new RpcException({ message: exception.getError(), code: HttpStatus.BAD_REQUEST }));
  }
}