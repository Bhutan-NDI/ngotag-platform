import { HttpStatus } from '@nestjs/common';

const MIN_HTTP_STATUS = 400;
const MAX_HTTP_STATUS = 599;

/**
 * First candidate that is genuinely an HTTP error status (400-599).
 *
 * RpcException producers in this repo use `code`, `statusCode` or `status` inconsistently, and a
 * library error's `code` (e.g. `ECONNREFUSED`) isn't a status at all. Numeric strings are accepted
 * since a status can cross NATS as JSON; anything else, including a non-error status, falls back
 * to 500.
 */
export function resolveHttpStatus(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    let numeric: number | undefined;
    if ('number' === typeof candidate) {
      numeric = candidate;
    } else if ('string' === typeof candidate && /^\d+$/.test(candidate)) {
      numeric = Number(candidate);
    }
    if (
      undefined !== numeric &&
      Number.isInteger(numeric) &&
      MIN_HTTP_STATUS <= numeric &&
      numeric <= MAX_HTTP_STATUS
    ) {
      return numeric;
    }
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * First candidate that yields a string, looking one level into a nested `message` (falling back
 * to `error` when `message` is absent -- this repo's own `CommonService.sendError` throws
 * `{ statusCode, error }` with no `message` field at all) so an object payload doesn't get
 * interpolated as '[object Object]'.
 */
export function resolveMessage(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if ('string' === typeof candidate && '' !== candidate) {
      return candidate;
    }
    if (candidate && 'object' === typeof candidate) {
      const { message, error } = candidate as { message?: unknown; error?: unknown };
      const nested = message ?? error;
      if ('string' === typeof nested && '' !== nested) {
        return nested;
      }
    }
  }
  return undefined;
}

/** Substitutes a real Error for a nullish/primitive rejection, since `exception.constructor`
 *  would otherwise throw before anything can be classified or logged. */
export function normaliseException(exception: unknown): unknown {
  if (null === exception || undefined === exception) {
    return new Error(`Nullish rejection (${String(exception)})`);
  }
  if ('object' !== typeof exception) {
    // The value itself is not interpolated: a rejected string can carry credentials.
    return new Error(`Non-object rejection (${typeof exception})`);
  }
  return exception;
}
