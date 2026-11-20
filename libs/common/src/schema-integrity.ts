import { BadRequestException, Logger } from '@nestjs/common';

export enum SchemaIntegrityMode {
  OFF = 'off',
  WARN = 'warn',
  ENFORCE = 'enforce'
}

export interface ISchemaVerificationRequest {
  did: string;
  schemaId: string;
  schemaUrl: string;
}

export interface ISchemaVerificationResult {
  status: 'verified' | 'legacy' | 'failed';
  reason?: string;
  schemaUrl: string;
  checksumAlgorithm?: string;
  expectedChecksum?: string;
  computedChecksum?: string;
  writerChecked: boolean;
}

export interface ISchemaIntegrityOptions {
  /** False after an irreversible write (schema creation, migration): a failure can only be logged. */
  canBlock?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;
const TIMEOUT_COOLDOWN_MS = 60_000;
let invalidModeWarned = false;
// Sequential issuance loops would otherwise pay the full timeout once per credential while the agent hangs.
let skipChecksUntil = 0;

class SchemaIntegrityTimeoutError extends Error {}

/** SCHEMA_INTEGRITY_CHECK: off (default) | warn | enforce. */
export function getSchemaIntegrityMode(logger?: Logger): SchemaIntegrityMode {
  const value = process.env.SCHEMA_INTEGRITY_CHECK?.trim().toLowerCase();
  if (!value) {
    return SchemaIntegrityMode.OFF;
  }
  if (Object.values(SchemaIntegrityMode).includes(value as SchemaIntegrityMode)) {
    return value as SchemaIntegrityMode;
  }
  if (!invalidModeWarned) {
    invalidModeWarned = true;
    logger?.warn(
      `[schema-integrity] invalid SCHEMA_INTEGRITY_CHECK "${value}"; expected off, warn or enforce. Check is off.`
    );
  }
  return SchemaIntegrityMode.OFF;
}

/** SCHEMA_INTEGRITY_TIMEOUT_MS, default 5000. */
export function getSchemaIntegrityTimeoutMs(): number {
  const parsed = Number(process.env.SCHEMA_INTEGRITY_TIMEOUT_MS);
  return Number.isFinite(parsed) && 0 < parsed ? parsed : DEFAULT_TIMEOUT_MS;
}

/** Only Ethereum W3C schemas carry a verifiable on-chain checksum. */
export function isSchemaIntegrityCheckable(did?: string | null): boolean {
  return Boolean(did?.startsWith('did:ethr:'));
}

export function schemaIdFromUrl(schemaUrl: string): string {
  return new URL(schemaUrl).pathname.split('/').filter(Boolean).pop() ?? '';
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SchemaIntegrityTimeoutError(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `verify` per the configured mode. Only a `failed` result in enforce mode with `canBlock`
 * throws; legacy records, errors and timeouts (agent, RPC or file server) log a warning. After a
 * timeout, checks are skipped for a minute.
 */
export async function checkSchemaIntegrity(
  request: ISchemaVerificationRequest,
  verify: (request: ISchemaVerificationRequest) => Promise<ISchemaVerificationResult>,
  logger: Logger,
  { canBlock = true }: ISchemaIntegrityOptions = {}
): Promise<ISchemaVerificationResult | undefined> {
  const mode = getSchemaIntegrityMode(logger);
  if (SchemaIntegrityMode.OFF === mode || !isSchemaIntegrityCheckable(request.did)) {
    return undefined;
  }
  if (Date.now() < skipChecksUntil) {
    logger.debug(`[schema-integrity] skipped ${request.schemaUrl}: a recent check timed out`);
    return undefined;
  }

  let result: ISchemaVerificationResult;
  try {
    result = await withTimeout(verify(request), getSchemaIntegrityTimeoutMs());
  } catch (error) {
    const timedOut = error instanceof SchemaIntegrityTimeoutError;
    if (timedOut) {
      skipChecksUntil = Date.now() + TIMEOUT_COOLDOWN_MS;
    }
    logger.warn(
      `[schema-integrity] could not verify ${request.schemaUrl}: ${error?.message ?? JSON.stringify(error)}${
        timedOut ? '; skipping checks for 60s' : ''
      }`
    );
    return undefined;
  }

  if ('verified' === result?.status) {
    logger.debug(`[schema-integrity] verified ${request.schemaUrl}`);
  } else if ('legacy' === result?.status) {
    logger.warn(`[schema-integrity] legacy record for ${request.schemaUrl}: ${result.reason}`);
  } else if ('failed' === result?.status) {
    logger.warn(`[schema-integrity] FAILED for ${request.schemaUrl}: ${result.reason}`);
    if (SchemaIntegrityMode.ENFORCE === mode && canBlock) {
      throw new BadRequestException(`Schema integrity check failed for ${request.schemaUrl}: ${result.reason}`);
    }
  } else {
    logger.warn(`[schema-integrity] unexpected verification response for ${request.schemaUrl}`);
    return undefined;
  }
  return result;
}
