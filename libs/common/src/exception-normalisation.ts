import { HttpStatus } from '@nestjs/common';

const MIN_HTTP_STATUS = 400;
const MAX_HTTP_STATUS = 599;

/**
 * Picks the first candidate that is genuinely an HTTP *error* status.
 *
 * Every caller uses this at an exception boundary -- there is no such thing as a 1xx/2xx/3xx
 * outcome once something has already been thrown. Accepting that range let a 200 or 302 that
 * leaked into `code`/`statusCode` be forwarded as a successful response for a request that
 * actually failed.
 *
 * Two further shapes made a validated resolver necessary in the first place. Producers in this
 * repository raise RpcException with the status under `code`, `statusCode` or `status` depending
 * on the service, so reading a single field sent routine 404s and 409s down the 500 path. And
 * library errors carry a `code` that is not a status at all -- `ECONNREFUSED` from a socket, for
 * instance -- which then flowed into a numeric comparison as NaN and made a downstream outage look
 * like a client error.
 *
 * Numeric strings are accepted because a status crossing NATS as JSON can arrive that way;
 * anything else, including a valid but non-error status, falls back to 500.
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
 * Picks the first candidate that yields a string, looking one level into `message` so an
 * RpcException payload does not end up interpolated as '[object Object]' into a log line or
 * returned as an object in the `message` field of a response.
 */
export function resolveMessage(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if ('string' === typeof candidate && '' !== candidate) {
      return candidate;
    }
    if (candidate && 'object' === typeof candidate) {
      const nested = (candidate as { message?: unknown }).message;
      if ('string' === typeof nested && '' !== nested) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * `switch (exception.constructor)` throws a TypeError on a nullish rejection, before anything is
 * classified, logged or answered. Callers use this to substitute a real Error first, so the
 * filters keep their single-emission contract for every input.
 */
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
