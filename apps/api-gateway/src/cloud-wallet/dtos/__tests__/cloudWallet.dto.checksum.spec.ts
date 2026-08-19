/**
 * Regression test — #73 review: ImportCloudWalletDto.checksum was validated only as a non-empty
 * string, letting any malformed value through to start real import work before agent-controller's
 * own checksum comparison ever ran. Fixed with a regex enforcing the exact expected SHA-256 hex
 * representation.
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

  it('accepts an uppercase-hex checksum too (case-insensitive)', async () => {
    const dto = plainToInstance(ImportCloudWalletDto, {
      ...VALID_BODY,
      checksum: VALID_BODY.checksum.toUpperCase()
    });

    const errors = await validate(dto);

    expect(errors.find((error) => 'checksum' === error.property)).toBeUndefined();
  });
});
