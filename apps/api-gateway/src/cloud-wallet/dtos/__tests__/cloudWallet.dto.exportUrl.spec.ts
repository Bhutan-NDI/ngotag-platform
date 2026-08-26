/**
 * Regression test — #73 review: ImportCloudWalletDto.exportUrl's @IsUrl had require_tld: false,
 * justified as "so an AWS-region-qualified S3 hostname isn't spuriously rejected as TLD-less" --
 * verified empirically that every legitimate S3 hostname shape (virtual-hosted, region-qualified,
 * path-style, dotted bucket name) already ends in .com/.cn and passes with the default
 * require_tld: true. The option bought nothing for S3, but did let bare/internal hostnames like
 * `https://minio-internal/...` or `https://localhost:9000/...` pass gateway validation -- exactly
 * the class of host this validator exists to narrow. Fixed by dropping require_tld: false.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ImportCloudWalletDto } from '../cloudWallet.dto';

const VALID_BODY = {
  exportUrl: 'https://example-bucket.s3.amazonaws.com/wallet-exports/artifact.db.gz',
  checksum: 'b06a1534375273fdd838693e45ce17aded75b0e73524768a92078d8c621419c9',
  passKey: 'a'.repeat(20)
};

function exportUrlErrors(exportUrl: string): ReturnType<typeof validate> {
  const dto = plainToInstance(ImportCloudWalletDto, { ...VALID_BODY, exportUrl });
  return validate(dto);
}

describe('ImportCloudWalletDto.exportUrl', () => {
  it('rejects a bare internal hostname with no TLD, e.g. a MinIO-style deployment', async () => {
    const errors = await exportUrlErrors('https://minio-internal/bucket/artifact.db.gz');

    expect(errors.find((error) => 'exportUrl' === error.property)).toBeDefined();
  });

  it('rejects a bare localhost URL with no TLD', async () => {
    const errors = await exportUrlErrors('https://localhost:9000/bucket/artifact.db.gz');

    expect(errors.find((error) => 'exportUrl' === error.property)).toBeDefined();
  });

  it.each([
    'https://example-bucket.s3.amazonaws.com/wallet-exports/artifact.db.gz',
    'https://example-bucket.s3.us-west-2.amazonaws.com/wallet-exports/artifact.db.gz',
    'https://s3.us-west-2.amazonaws.com/example-bucket/wallet-exports/artifact.db.gz',
    'https://example-bucket.s3.amazonaws.com.cn/wallet-exports/artifact.db.gz'
  ])('still accepts a legitimate S3 hostname shape: %s', async (exportUrl) => {
    const errors = await exportUrlErrors(exportUrl);

    expect(errors.find((error) => 'exportUrl' === error.property)).toBeUndefined();
  });

  it('rejects a scheme-less URL (require_protocol) — the metadata-endpoint-style gap this validator closes', async () => {
    const errors = await exportUrlErrors('169.254.169.254/latest/meta-data/');

    expect(errors.find((error) => 'exportUrl' === error.property)).toBeDefined();
  });
});
