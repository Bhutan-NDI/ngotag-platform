// Matches agent-controller's ceiling with its default purge TTL (7 days minus 1 hour); set
// PROOF_REQUEST_EXPIRY_MAX_SECONDS when a deployment changes its purge TTLs.
export const MIN_PROOF_REQUEST_EXPIRES_IN_SECONDS = 300;
export const DEFAULT_MAX_PROOF_REQUEST_EXPIRES_IN_SECONDS = 601_200;
export const PROOF_REQUEST_EXPIRY_MAX_SECONDS_ENV = 'PROOF_REQUEST_EXPIRY_MAX_SECONDS';

/** Read per call, not at import, because the api-gateway main.ts loads .env after its modules are imported. */
export function getMaxProofRequestExpiresInSeconds(): number {
  const raw = process.env[PROOF_REQUEST_EXPIRY_MAX_SECONDS_ENV];
  if (raw === undefined || '' === raw.trim()) {
    return DEFAULT_MAX_PROOF_REQUEST_EXPIRES_IN_SECONDS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_PROOF_REQUEST_EXPIRES_IN_SECONDS) {
    throw new Error(
      `${PROOF_REQUEST_EXPIRY_MAX_SECONDS_ENV} must be a whole number of seconds, at least ${MIN_PROOF_REQUEST_EXPIRES_IN_SECONDS}, got: "${raw}"`
    );
  }
  return value;
}
