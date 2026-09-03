import { Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ExceptionResponse } from './interface';
import { ResponseMessages } from '@credebl/common/response-messages';
import { normaliseException, resolveHttpStatus, resolveMessage } from '@credebl/common/exception-normalisation';

@Catch()
export class CustomExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('CustomExceptionFilter');

  catch(rawException: HttpException, host: ArgumentsHost): void {
    // Guards against nullish/primitive rejections that would throw below.
    const exception = normaliseException(rawException) as HttpException;
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    let errorResponse;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;

    // JSON.stringify throws on a circular rejection; treat that as "not empty" rather than crash.
    let stringified: string;
    try {
      stringified = JSON.stringify(exception);
    } catch {
      stringified = '';
    }
    if (!exception || '{}' === stringified) {
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

    // `.includes` requires a string; message may instead be a validation array or a nested object.
    if (
      'string' === typeof exceptionResponse.message &&
      exceptionResponse.message.includes(ResponseMessages.nats.error.noSubscribers)
    ) {
      exceptionResponse.message = ResponseMessages.nats.error.noSubscribers;
    }

    // This filter answers the request itself, so it must log here or the exception goes unrecorded.
    // The same resolvedStatus feeds the log level, the response body, and response.status() below.
    const resolvedStatus = resolveHttpStatus(exceptionResponse.statusCode, status);
    // Validation-error arrays pass through unchanged; anything else is resolved to a string.
    const message = Array.isArray(exceptionResponse.message)
      ? exceptionResponse.message
      : (resolveMessage(exceptionResponse.message, exceptionResponse.error) ?? 'Something went wrong!');

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
