import { headers } from 'nats';
import {
  issuanceDeadline,
  ISSUANCE_ADMISSION_MS,
  readIssuanceDeadline,
  ISSUANCE_DEADLINE_HEADER
} from './issuanceDeadline';

it('retains elapsed transport time and clamps a future deadline', () => {
  expect(issuanceDeadline(undefined, 100)).toBe(100 + ISSUANCE_ADMISSION_MS);
  expect(issuanceDeadline('500', 200)).toBe(500);
  expect(issuanceDeadline(99999999, 200)).toBe(200 + ISSUANCE_ADMISSION_MS);
});

it.each([null, '', 'NaN', 'secret', '-1', 0, 100, Infinity, 1.5])(
  'rejects invalid or expired admission %s',
  (value) => {
    expect(() => issuanceDeadline(value, 100)).toThrow('no offer was dispatched');
  }
);

it('distinguishes a legacy NATS message from an explicitly blank deadline', () => {
  const metadata = headers();
  expect(metadata.get(ISSUANCE_DEADLINE_HEADER)).toBe('');
  expect(issuanceDeadline(readIssuanceDeadline(metadata), 100)).toBe(10100);
  metadata.set(ISSUANCE_DEADLINE_HEADER, '');
  expect(() => issuanceDeadline(readIssuanceDeadline(metadata), 100)).toThrow('invalid');
});
