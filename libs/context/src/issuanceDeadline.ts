import { ServiceUnavailableException } from '@nestjs/common';

// Bound interactive admission from gateway receipt, not from the last queue hop.
// This leaves headroom below the deployed 60-second ALB idle timeout; it is not
// an execution timeout or a promise that an already dispatched offer will finish.
export const ISSUANCE_ADMISSION_MS = 10000;
export const ISSUANCE_INTERACTIVE_QUEUE_MS = 1000;
export const ISSUANCE_DEADLINE_KEY = 'issuanceAdmissionDeadline';
export const ISSUANCE_DEADLINE_HEADER = 'issuance-admission-deadline';
export const ISSUANCE_COMMANDS = new Set([
  'send-credential-create-offer',
  'send-credential-create-offer-oob',
  'out-of-band-credential-offer'
]);

export function issuanceDeadline(value?: unknown, now = Date.now()): number {
  if (undefined === value) {
    return now + ISSUANCE_ADMISSION_MS;
  }
  const deadline = 'string' === typeof value && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if ('number' !== typeof deadline || !Number.isSafeInteger(deadline) || deadline <= now) {
    throw new ServiceUnavailableException('Issuance admission expired or invalid; no offer was dispatched');
  }
  // A peer cannot extend the local maximum by supplying a distant deadline.
  return Math.min(deadline, now + ISSUANCE_ADMISSION_MS);
}

// NATS returns an empty string for an absent header; distinguish legacy senders
// from peers that explicitly supplied an invalid blank deadline.
export function readIssuanceDeadline(headers?: {
  has(name: string): boolean;
  get(name: string): string;
}): string | undefined {
  return headers?.has(ISSUANCE_DEADLINE_HEADER) ? headers.get(ISSUANCE_DEADLINE_HEADER) : undefined;
}
