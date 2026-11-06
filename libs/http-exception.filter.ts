import { Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@prisma/client/runtime/library';
import { Observable, throwError } from 'rxjs';
import { normaliseException, resolveHttpStatus, resolveMessage } from '@credebl/common/exception-normalisation';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('CommonService');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  catch(rawException: any): Observable<any> {
    // Guards against nullish/primitive rejections; exception.constructor below would throw first.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exception = normaliseException(rawException) as any;

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = '';
    switch (exception.constructor) {
      case HttpException:
        httpStatus = resolveHttpStatus(exception.getStatus());
        message = resolveMessage(exception.getResponse(), exception.message) ?? 'Internal server error';
        break;
      case RpcException: {
        // Already classified upstream; forward unchanged, but record the hop so it isn't silent.
        const rpcError = exception.getError() as { code?: unknown; statusCode?: unknown; status?: unknown };
        const rpcStatus = resolveHttpStatus(rpcError?.code, rpcError?.statusCode, rpcError?.status);
        this.log(exception, rpcStatus, this.describe(exception, rpcError));
        return throwError(() => rpcError);
      }
      case PrismaClientKnownRequestError:
        switch (exception.code) {
          case 'P2002': // Unique constraint failed on the {constraint}
          case 'P2000': // The provided value for the column is too long for the column's type. Column: {column_name}
          case 'P2001': // The record searched for in the where condition ({model_name}.{argument_name} = {argument_value}) does not exist
          case 'P2005': // The value {field_value} stored in the database for the field {field_name} is invalid for the field's type
          case 'P2006': // The provided value {field_value} for {model_name} field {field_name} is not valid
          case 'P2010': // Raw query failed. Code: {code}. Message: {message}
          case 'P2011': // Null constraint violation on the {constraint}
          case 'P2017': // The records for relation {relation_name} between the {parent_name} and {child_name} models are not connected.
          case 'P2021': // The table {table} does not exist in the current database.
          case 'P2022': // The column {column} does not exist in the current database.
            httpStatus = HttpStatus.BAD_REQUEST;
            message = exception?.response?.message || exception?.message;
            break;
          case 'P2023': // Inconsistent column data: {message}
            httpStatus = HttpStatus.BAD_REQUEST;
            message = exception?.meta?.message || exception?.message;
            break;
          case 'P2018': // The required connected records were not found. {details}
          case 'P2025': // An operation failed because it depends on one or more records that were required but not found. {cause}
          case 'P2015': // A related record could not be found. {details}
            httpStatus = HttpStatus.NOT_FOUND;
            message = exception?.message;
            break;
          default:
            httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
            message = exception?.response?.message || exception?.message || 'Internal server error';
        }
        break;
      case PrismaClientValidationError:
        httpStatus = HttpStatus.BAD_REQUEST;
        message = exception?.message || exception?.response?.message;
        break;
      default:
        // eslint-disable-next-line no-case-declarations
        // exception.code may be a non-HTTP value (e.g. 'ECONNREFUSED'), not a status.
        httpStatus = resolveHttpStatus(
          exception.response?.status,
          exception.response?.statusCode,
          exception.statusCode,
          exception.code
        );
        // eslint-disable-next-line no-case-declarations
        message =
          exception.response?.data?.message ||
          exception.response?.message ||
          exception?.message ||
          'Internal server error';
    }
    this.log(exception, httpStatus, this.describe(exception, message));
    return throwError(() => new RpcException({ message, code: httpStatus }));
  }

  /** Logged once per exception, at a level derived from httpStatus, so a 4xx isn't recorded as an error. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private log(exception: any, httpStatus: number, description: string): void {
    const level = HttpStatus.INTERNAL_SERVER_ERROR <= httpStatus ? 'error' : 'warn';
    if (exception instanceof Error) {
      this.logger[level](`${httpStatus}: ${description}`, exception);
    } else {
      this.logger[level](`${httpStatus}: ${description}`);
    }
  }

  /** Prefers the classified message; falls back to something better than '[object Object]'. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private describe(exception: any, resolved: unknown): string {
    return (
      resolveMessage(resolved, exception instanceof Error ? exception.message : undefined) ??
      `unclassified ${typeof exception} exception`
    );
  }
}
