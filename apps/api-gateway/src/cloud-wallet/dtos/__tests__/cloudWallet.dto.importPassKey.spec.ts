/**
 * Regression test — #73 review: ImportCloudWalletDto.passKey was missing the @MinLength(16) that
 * ExportCloudWalletDto.passKey already has, even though agent-controller enforces the same floor
 * on both routes. A too-short passKey passed gateway validation, crossed NATS, ran
 * checkUserExist + _commonCloudWalletInfo + checkAgentHealth, and only then failed at the agent --
 * surfacing as an opaque RpcException rather than a field-level validation error, for the same
 * passKey the caller supplied at export time.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ImportCloudWalletDto } from '../cloudWallet.dto';

const VALID_BODY = {
  exportUrl: 'https://example-bucket.s3.amazonaws.com/wallet-exports/artifact.db.gz',
  checksum: 'b06a1534375273fdd838693e45ce17aded75b0e73524768a92078d8c621419c9',
  passKey: 'a'.repeat(20)
};

describe('ImportCloudWalletDto.passKey', () => {
  it('rejects a passKey shorter than 16 characters', async () => {
    const dto = plainToInstance(ImportCloudWalletDto, { ...VALID_BODY, passKey: 'too-short' });

    const errors = await validate(dto);

    expect(errors.find((error) => 'passKey' === error.property)).toBeDefined();
  });

  it('accepts a passKey exactly 16 characters long', async () => {
    const dto = plainToInstance(ImportCloudWalletDto, { ...VALID_BODY, passKey: 'a'.repeat(16) });

    const errors = await validate(dto);

    expect(errors.find((error) => 'passKey' === error.property)).toBeUndefined();
  });

  it('accepts a passKey longer than 16 characters', async () => {
    const dto = plainToInstance(ImportCloudWalletDto, VALID_BODY);

    const errors = await validate(dto);

    expect(errors.find((error) => 'passKey' === error.property)).toBeUndefined();
  });
});
