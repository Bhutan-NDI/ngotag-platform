import { Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ExceptionResponse } from './interface';
import { ResponseMessages } from '@credebl/common/response-messages';
import { normaliseException, resolveHttpStatus, resolveMessage } from '@credebl/common/exception-normalisation';

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

    // `.includes` assumes a string. A nested structured payload (e.g. `{ message: { error: ... } }`)
    // reaches here as an object, not a string or the validation-error array Nest normally sends.
    if (
      'string' === typeof exceptionResponse.message &&
      exceptionResponse.message.includes(ResponseMessages.nats.error.noSubscribers)
    ) {
      exceptionResponse.message = ResponseMessages.nats.error.noSubscribers;
    }

    // Logged here because this filter answers the request itself: 21 controllers register it with
    // @UseFilters, so the exception never reaches the global AllExceptionsFilter and, until now,
    // produced no record at all. Same contract as the other two: classify first, emit once, and
    // let one validated status drive the level, the response body, and response.status() alike --
    // a numeric-string or non-HTTP statusCode must not reach Express unvalidated, and a status that
    // isn't genuinely an HTTP error (e.g. a stray 200) must not turn a caught exception into a
    // reported success.
    const resolvedStatus = resolveHttpStatus(exceptionResponse.statusCode, status);
    // Array messages are Nest's validation-error format and pass through unchanged; anything else
    // that isn't already a plain string is resolved (looking one level into a nested `message`)
    // rather than interpolated as an object.
    const message = Array.isArray(exceptionResponse.message)
      ? exceptionResponse.message
      : (resolveMessage(exceptionResponse.message) ?? 'Something went wrong!');

    errorResponse = {
      statusCode: resolvedStatus,
      message,
      error: exceptionResponse.error ? exceptionResponse.error : ResponseMessages.errorMessages.serverError
    };

    const level = HttpStatus.INTERNAL_SERVER_ERROR <= resolvedStatus ? 'error' : 'warn';
    const summary = `${resolvedStatus}: ${Array.isArray(message) ? message.join('; ') : message}`;
    if (exception instanceof Error) {
      this.logger[level](summary, exception);
    } else {
      this.logger[level](summary);
    }

    response.status(resolvedStatus).json(errorResponse);
  }
}
