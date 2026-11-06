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

const MAX_MESSAGE_DEPTH = 3;

function resolveMessageAtDepth(candidates: unknown[], depth: number): string | undefined {
  if (0 === depth) {
    return undefined;
  }
  for (const candidate of candidates) {
    if ('string' === typeof candidate && '' !== candidate) {
      return candidate;
    }
    if (candidate && 'object' === typeof candidate) {
      const { message, error } = candidate as { message?: unknown; error?: unknown };
      const nested = resolveMessageAtDepth([message, error], depth - 1);
      if (undefined !== nested) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * First candidate that yields a string, unwrapping into a nested `message` or `error` (whichever
 * is present) up to a few levels deep -- both `{ message: { error: '...' } }` and this repo's
 * `CommonService.sendError` shape `{ statusCode, error: '...' }` (no `message` field at all) occur
 * as real exception payloads, and this avoids interpolating either as '[object Object]'.
 *
 * Depth is capped rather than unbounded so a self-referencing payload can't recurse forever.
 */
export function resolveMessage(...candidates: unknown[]): string | undefined {
  return resolveMessageAtDepth(candidates, MAX_MESSAGE_DEPTH);
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
