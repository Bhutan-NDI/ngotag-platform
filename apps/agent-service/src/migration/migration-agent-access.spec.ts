/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { MigrationAgentAccess } from './migration-agent-access';

const build = (row: object | null) => {
  const agentServiceRepository = { getAgentApiKey: jest.fn().mockResolvedValue(row), platformAdminAgent: jest.fn() };
  const commonService = {
    decryptPassword: jest.fn(async (value: string) => `decrypted(${value})`),
    dataEncryption: jest.fn((value: string) => `encrypted(${value})`)
  };
  return {
    access: new MigrationAgentAccess(agentServiceRepository as never, commonService as never),
    agentServiceRepository,
    commonService
  };
};

describe('MigrationAgentAccess.dedicatedOfOrg', () => {
  it("returns the endpoint and decrypted token of the org's own agent row", async () => {
    const { access, agentServiceRepository, commonService } = build({
      agentEndPoint: 'https://admin.org.example.com',
      apiKey: 'CIPHERTEXT'
    });

    await expect(access.dedicatedOfOrg('org-1')).resolves.toEqual({
      endpoint: 'https://admin.org.example.com',
      token: 'decrypted(CIPHERTEXT)'
    });

    expect(agentServiceRepository.getAgentApiKey).toHaveBeenCalledWith('org-1');
    expect(commonService.decryptPassword).toHaveBeenCalledWith('CIPHERTEXT');
  });

  it.each([
    ['there is no row', null],
    ['the row has no endpoint', { agentEndPoint: '', apiKey: 'X' }],
    ['the row has no token', { agentEndPoint: 'https://a.example.com', apiKey: null }]
  ])('returns nothing when %s', async (_name, row) => {
    const { access, commonService } = build(row);

    await expect(access.dedicatedOfOrg('org-1')).resolves.toBeUndefined();

    expect(commonService.decryptPassword).not.toHaveBeenCalled();
  });
});
