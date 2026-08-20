/**
 * Regression tests — #73 review:
 *   1. ImportCloudWalletDto.checksum was validated only as a non-empty string, letting any
 *      malformed value through to start real import work before agent-controller's own checksum
 *      comparison ever ran. Fixed with a regex enforcing the exact expected SHA-256 hex
 *      representation.
 *   2. A second review pass caught that the /i (case-insensitive) flag on that regex admits an
 *      uppercase digest the agent can never accept: WalletPortabilityService.gzipAndChecksum
 *      returns hash.digest('hex') (always lowercase) and compares it with a case-sensitive !==.
 *      An uppercased-but-correct checksum passed gateway validation, consumed the tenant's only
 *      portability slot, and streamed the whole artifact down from S3, only to fail "Checksum
 *      mismatch" at the agent. Fixed by lowercasing in the @Transform rather than narrowing the
 *      regex, so the DTO's own (deliberate) case-insensitive *input* convenience is preserved.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ImportCloudWalletDto } from '../cloudWallet.dto';

const VALID_BODY = {
  exportUrl: 'https://example-bucket.s3.amazonaws.com/wallet-exports/artifact.db.gz',
  checksum: 'b06a1534375273fdd838693e45ce17aded75b0e73524768a92078d8c621419c9',
  passKey: 'a'.repeat(20)
};

describe('ImportCloudWalletDto.checksum', () => {
  it('rejects a checksum that is not a 64-character hex digest', async () => {
    const dto = plainToInstance(ImportCloudWalletDto, { ...VALID_BODY, checksum: 'not-a-real-checksum' });

    const errors = await validate(dto);

    const checksumError = errors.find((error) => 'checksum' === error.property);
    expect(checksumError).toBeDefined();
  });

  it('rejects a checksum one character short of 64 hex characters', async () => {
    const dto = plainToInstance(ImportCloudWalletDto, {
      ...VALID_BODY,
      checksum: '4c63119399d4c98fb1dbc2b31943374c74e7026d75903828f0a2bae79ca2b4'
    });

    const errors = await validate(dto);

    expect(errors.find((error) => 'checksum' === error.property)).toBeDefined();
  });

  it('accepts a valid 64-character hex checksum', async () => {
    const dto = plainToInstance(ImportCloudWalletDto, VALID_BODY);

    const errors = await validate(dto);

    expect(errors.find((error) => 'checksum' === error.property)).toBeUndefined();
  });

  it('accepts an uppercase-hex checksum too (case-insensitive) and normalizes it to lowercase — the agent compares case-sensitively', async () => {
    const dto = plainToInstance(ImportCloudWalletDto, {
      ...VALID_BODY,
      checksum: VALID_BODY.checksum.toUpperCase()
    });

    const errors = await validate(dto);

    expect(errors.find((error) => 'checksum' === error.property)).toBeUndefined();
    // Not just "no validation error" -- the value actually reaching agent-controller must be
    // lowercase, or a correct-but-uppercased checksum fails the agent's own case-sensitive
    // comparison after the tenant's portability slot and the whole download have already been
    // spent.
    expect(dto.checksum).toBe(VALID_BODY.checksum);
  });
});
