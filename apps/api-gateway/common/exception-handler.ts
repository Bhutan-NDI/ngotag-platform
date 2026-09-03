import { Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ExceptionResponse } from './interface';
import { ResponseMessages } from '@credebl/common/response-messages';
import { normaliseException, resolveHttpStatus } from '@credebl/common/exception-normalisation';

@Catch()
export class CustomExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('CustomExceptionFilter');

  catch(rawException: HttpException, host: ArgumentsHost): void {
    // Nullish and primitive rejections would throw below before anything is answered.
    const exception = normaliseException(rawException) as HttpException;
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    let errorResponse;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;

    if (!exception || '{}' === JSON.stringify(exception)) {
      errorResponse = {
        statusCode: status,
        message: 'Something went wrong!',
        error: ResponseMessages.errorMessages.serverError
      };
    }
    if (exception instanceof HttpException) {
      status = exception.getStatus();
    }

    let exceptionResponse: ExceptionResponse = {} as ExceptionResponse;
    const exceptionResponseData = exception.getResponse ? exception.getResponse() : exception;

    if ('string' === typeof exceptionResponseData) {
      exceptionResponse.message = exceptionResponseData;
    } else {
      exceptionResponse = exceptionResponseData as unknown as ExceptionResponse;
    }

    if (exceptionResponse.message && exceptionResponse.message.includes(ResponseMessages.nats.error.noSubscribers)) {
      exceptionResponse.message = ResponseMessages.nats.error.noSubscribers;
    }
    errorResponse = {
      statusCode: exceptionResponse.statusCode ? exceptionResponse.statusCode : status,
      message: exceptionResponse.message ? exceptionResponse.message : 'Something went wrong!',
      error: exceptionResponse.error ? exceptionResponse.error : ResponseMessages.errorMessages.serverError
    };
    // Logged here because this filter answers the request itself: 21 controllers register it with
    // @UseFilters, so the exception never reaches the global AllExceptionsFilter and, until now,
    // produced no record at all. Same contract as the other two: classify first, emit once, and
    // let the resolved status pick the level.
    const resolvedStatus = resolveHttpStatus(errorResponse.statusCode);
    const level = HttpStatus.INTERNAL_SERVER_ERROR <= resolvedStatus ? 'error' : 'warn';
    const summary = `${resolvedStatus}: ${errorResponse.message}`;
    if (exception instanceof Error) {
      this.logger[level](summary, exception);
    } else {
      this.logger[level](summary);
    }

    response.status(errorResponse.statusCode).json(errorResponse);
  }
}
