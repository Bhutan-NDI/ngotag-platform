import { BadRequestException, Logger } from '@nestjs/common';
import {
  checkSchemaIntegrity,
  getSchemaIntegrityMode,
  ISchemaVerificationResult,
  SchemaIntegrityMode,
  schemaIdFromUrl
} from './schema-integrity';

const request = { did: 'did:ethr:sepolia:0xabc', schemaId: 'id1', schemaUrl: 'https://schemas.example/schemas/id1' };
const result = (status: ISchemaVerificationResult['status']): ISchemaVerificationResult => ({
  status,
  reason: 'reason',
  schemaUrl: request.schemaUrl,
  writerChecked: false
});

describe('checkSchemaIntegrity', () => {
  let logger: Logger;
  let now = 0;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    logger = { warn: jest.fn(), debug: jest.fn() } as unknown as Logger;
    delete process.env.SCHEMA_INTEGRITY_CHECK;
    delete process.env.SCHEMA_INTEGRITY_TIMEOUT_MS;
    // Each test starts past any cooldown an earlier test began.
    now += 10 * 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('does not call the agent when the check is unset', async () => {
    const verify = jest.fn();
    await expect(checkSchemaIntegrity(request, verify, logger)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('skips non-Ethereum schemas', async () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'enforce';
    const verify = jest.fn();
    await checkSchemaIntegrity({ ...request, did: 'did:polygon:testnet:0xabc' }, verify, logger);
    expect(verify).not.toHaveBeenCalled();
  });

  it('only warns on a failed check in warn mode', async () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'warn';
    await expect(checkSchemaIntegrity(request, async () => result('failed'), logger)).resolves.toMatchObject({
      status: 'failed'
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('blocks a failed check in enforce mode', async () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'enforce';
    await expect(checkSchemaIntegrity(request, async () => result('failed'), logger)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('does not block a failed check after an irreversible write', async () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'enforce';
    await expect(
      checkSchemaIntegrity(request, async () => result('failed'), logger, { canBlock: false })
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it.each(['verified', 'legacy'] as const)('continues on a %s result in enforce mode', async (status) => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'enforce';
    await expect(checkSchemaIntegrity(request, async () => result(status), logger)).resolves.toMatchObject({
      status
    });
  });

  it('continues when the agent errors or returns an unexpected response', async () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'enforce';
    const failing = async (): Promise<ISchemaVerificationResult> => {
      throw new Error('agent down');
    };
    await expect(checkSchemaIntegrity(request, failing, logger)).resolves.toBeUndefined();
    await expect(
      checkSchemaIntegrity(request, async () => ({}) as ISchemaVerificationResult, logger)
    ).resolves.toBeUndefined();
  });

  it('continues when the agent does not answer in time', async () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'enforce';
    process.env.SCHEMA_INTEGRITY_TIMEOUT_MS = '20';
    const hanging = (): Promise<ISchemaVerificationResult> => new Promise(() => undefined);
    await expect(checkSchemaIntegrity(request, hanging, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 20ms'));
  });

  it('skips checks for a minute after a timeout', async () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'enforce';
    process.env.SCHEMA_INTEGRITY_TIMEOUT_MS = '20';
    await checkSchemaIntegrity(request, () => new Promise(() => undefined), logger);

    const verify = jest.fn(async () => result('failed'));
    now += 59_000;
    await expect(checkSchemaIntegrity(request, verify, logger)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();

    now += 2_000;
    await expect(checkSchemaIntegrity(request, verify, logger)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not skip checks after an error', async () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'warn';
    await checkSchemaIntegrity(request, async () => Promise.reject(new Error('agent down')), logger);
    const verify = jest.fn(async () => result('verified'));
    await checkSchemaIntegrity(request, verify, logger);
    expect(verify).toHaveBeenCalled();
  });
});

describe('getSchemaIntegrityMode', () => {
  afterEach(() => delete process.env.SCHEMA_INTEGRITY_CHECK);

  it('reads the mode case-insensitively', () => {
    process.env.SCHEMA_INTEGRITY_CHECK = ' Enforce ';
    expect(getSchemaIntegrityMode()).toBe(SchemaIntegrityMode.ENFORCE);
  });

  it('treats an invalid value as off and warns', () => {
    process.env.SCHEMA_INTEGRITY_CHECK = 'enforced';
    const logger = { warn: jest.fn() } as unknown as Logger;
    expect(getSchemaIntegrityMode(logger)).toBe(SchemaIntegrityMode.OFF);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('enforced'));
  });
});

describe('schemaIdFromUrl', () => {
  it('returns the last path segment', () => {
    expect(schemaIdFromUrl('https://dev-schema.ngotag.com/schemas/1f9d3786-73b6-4a75-90f2-35550fa6d07f')).toBe(
      '1f9d3786-73b6-4a75-90f2-35550fa6d07f'
    );
  });
});
