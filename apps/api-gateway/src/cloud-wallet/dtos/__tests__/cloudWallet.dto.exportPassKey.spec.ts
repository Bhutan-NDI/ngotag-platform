/**
 * Regression test — #73 review: ExportCloudWalletDto.passKey had no minimum-length constraint,
 * letting a too-short passKey (e.g. "secret") pass gateway validation, cross NATS, run
 * checkUserExist + _commonCloudWalletInfo + checkAgentHealth, and only then fail at the agent --
 * surfacing as an opaque RpcException rather than a field-level validation error, for a value
 * that protects the exported wallet artifact. Fixed with @MinLength(16), mirroring
 * agent-controller's own MIN_PASSKEY_LENGTH.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ExportCloudWalletDto } from '../cloudWallet.dto';

const VALID_BODY = {
  passKey: 'a'.repeat(20),
  email: 'holder@example.com'
};

describe('ExportCloudWalletDto.passKey', () => {
  it('rejects a passKey shorter than 16 characters', async () => {
    const dto = plainToInstance(ExportCloudWalletDto, { ...VALID_BODY, passKey: 'too-short' });

    const errors = await validate(dto);

    expect(errors.find((error) => 'passKey' === error.property)).toBeDefined();
  });

  it('accepts a passKey exactly 16 characters long', async () => {
    const dto = plainToInstance(ExportCloudWalletDto, { ...VALID_BODY, passKey: 'a'.repeat(16) });

    const errors = await validate(dto);

    expect(errors.find((error) => 'passKey' === error.property)).toBeUndefined();
  });

  it('accepts a passKey longer than 16 characters', async () => {
    const dto = plainToInstance(ExportCloudWalletDto, VALID_BODY);

    const errors = await validate(dto);

    expect(errors.find((error) => 'passKey' === error.property)).toBeUndefined();
  });
});
