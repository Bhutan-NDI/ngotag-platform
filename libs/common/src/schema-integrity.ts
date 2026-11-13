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

/** SCHEMA_INTEGRITY_CHECK: off (default) | warn | enforce. */
export function getSchemaIntegrityMode(): SchemaIntegrityMode {
  const value = process.env.SCHEMA_INTEGRITY_CHECK?.trim().toLowerCase();
  return Object.values(SchemaIntegrityMode).includes(value as SchemaIntegrityMode)
    ? (value as SchemaIntegrityMode)
    : SchemaIntegrityMode.OFF;
}

/** Only Ethereum W3C schemas carry a verifiable on-chain checksum. */
export function isSchemaIntegrityCheckable(did?: string | null): boolean {
  return Boolean(did?.startsWith('did:ethr:'));
}

export function schemaIdFromUrl(schemaUrl: string): string {
  return new URL(schemaUrl).pathname.split('/').filter(Boolean).pop() ?? '';
}

/**
 * Runs `verify` per the configured mode. Only a `failed` result in enforce mode throws;
 * legacy records and verification errors (RPC or file server unreachable) log a warning.
 */
export async function checkSchemaIntegrity(
  request: ISchemaVerificationRequest,
  verify: (request: ISchemaVerificationRequest) => Promise<ISchemaVerificationResult>,
  logger: Logger
): Promise<ISchemaVerificationResult | undefined> {
  const mode = getSchemaIntegrityMode();
  if (SchemaIntegrityMode.OFF === mode || !isSchemaIntegrityCheckable(request.did)) {
    return undefined;
  }

  let result: ISchemaVerificationResult;
  try {
    result = await verify(request);
  } catch (error) {
    logger.warn(`[schema-integrity] could not verify ${request.schemaUrl}: ${error?.message ?? JSON.stringify(error)}`);
    return undefined;
  }

  if ('verified' === result?.status) {
    logger.debug(`[schema-integrity] verified ${request.schemaUrl}`);
  } else if ('legacy' === result?.status) {
    logger.warn(`[schema-integrity] legacy record for ${request.schemaUrl}: ${result.reason}`);
  } else if ('failed' === result?.status) {
    logger.warn(`[schema-integrity] FAILED for ${request.schemaUrl}: ${result.reason}`);
    if (SchemaIntegrityMode.ENFORCE === mode) {
      throw new BadRequestException(`Schema integrity check failed for ${request.schemaUrl}: ${result.reason}`);
    }
  } else {
    logger.warn(`[schema-integrity] unexpected verification response for ${request.schemaUrl}`);
    return undefined;
  }
  return result;
}
