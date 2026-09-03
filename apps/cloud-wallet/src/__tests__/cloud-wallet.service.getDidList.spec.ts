// getDidList's isDefault=true result carries hashTenantID on a plain object.
import { createHash } from 'crypto';

import { CloudWalletService } from '../cloud-wallet.service';

const AGENT_ENDPOINT = 'https://agent.example.com';
const TENANT_ID = 'tenant-under-test';

function makeService(httpGetResult: unknown): { service: CloudWalletService; commonService: { httpGet: jest.Mock } } {
  const commonService = {
    httpGet: jest.fn(async () => httpGetResult),
    handleError: jest.fn(async (error: unknown) => {
      throw error;
    })
  };
  const cloudWalletRepository = {
    getCloudSubWallet: jest.fn(async () => ({ tenantId: TENANT_ID }))
  };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const service = new CloudWalletService(commonService as never, cloudWalletRepository as never, logger as never);
  jest
    .spyOn(service as never, '_commonCloudWalletInfo')
    .mockResolvedValue([{ agentEndpoint: AGENT_ENDPOINT }, 'decrypted-api-key'] as never);
  return { service, commonService };
}

describe('CloudWalletService.getDidList', () => {
  it('reshapes the isDefault=true list into a single object carrying hashTenantID, surviving a real JSON hop', async () => {
    const { service } = makeService([{ did: 'did:example:123' }]);

    const result = await service.getDidList({ userId: 'user-1', email: 'user@example.com', isDefault: true });
    // Simulates the real HTTP/NATS round-trip -- an array-bolted property wouldn't survive this.
    const overWire = JSON.parse(JSON.stringify({ data: result }));

    expect(overWire.data.hashTenantID).toBe(createHash('md5').update(TENANT_ID).digest('hex'));
    expect(overWire.data.did).toBe('did:example:123');
  });

  it('takes the first (most recent) default when more than one isDefault record exists', async () => {
    const { service } = makeService([{ did: 'did:newest' }, { did: 'did:older' }]);

    const result = await service.getDidList({ userId: 'user-1', email: 'user@example.com', isDefault: true });

    expect(result['did']).toBe('did:newest');
  });

  it('throws when isDefault=true and the tenant has no default DID', async () => {
    const { service } = makeService([]);

    await expect(
      service.getDidList({ userId: 'user-1', email: 'user@example.com', isDefault: true })
    ).rejects.toThrow();
  });

  it('leaves the non-default (full list) case as an untouched array', async () => {
    const { service } = makeService([{ did: 'did:one' }, { did: 'did:two' }]);

    const result = await service.getDidList({ userId: 'user-1', email: 'user@example.com', isDefault: false });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ did: 'did:one' }, { did: 'did:two' }]);
  });
});
