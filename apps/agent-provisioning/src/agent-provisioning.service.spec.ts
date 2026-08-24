import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { exec } from 'child_process';
import { AgentType } from '@credebl/enum/enum';
import { AgentProvisioningService } from './agent-provisioning.service';
import { IWalletProvision } from './interface/agent-provisioning.interfaces';

jest.mock('child_process', () => ({
  exec: jest.fn()
}));

describe('AgentProvisioningService.walletProvision', () => {
  const execMock = exec as unknown as jest.Mock;
  const payload: IWalletProvision = {
    orgId: 'org-id',
    externalIp: 'agent.example.com',
    walletName: 'wallet',
    walletPassword: 'wallet-password',
    seed: 'seed',
    webhookEndpoint: 'https://webhook.example.com',
    walletStorageHost: 'postgres',
    walletStoragePort: '5432',
    walletStorageUser: 'wallet-user',
    walletStoragePassword: 'storage-password',
    internalIp: '127.0.0.1',
    containerName: 'agent-container',
    agentType: AgentType.AFJ,
    orgName: 'Organisation',
    indyLedger: '[]',
    protocol: 'https',
    credoImage: 'credo-controller:test',
    tenant: false,
    inboundEndpoint: 'https://inbound.example.com'
  };

  let service: AgentProvisioningService;

  beforeEach(() => {
    execMock.mockReset();
    process.env.AFJ_AGENT_SPIN_UP = '/scripts/start-agent.sh';
    process.env.AFJ_AGENT_ENDPOINT_PATH = '/endpoints/';

    service = new AgentProvisioningService({
      log: jest.fn(),
      error: jest.fn()
    } as unknown as Logger);
  });

  it('returns a clean RPC failure when the provisioning script exits non-zero', async () => {
    execMock.mockImplementation((_command, callback) => {
      callback(new Error('Agent readiness check failed'), '', 'Agent did not become ready');
    });
    const endpointCheck = jest.spyOn(service, 'checkFileExistence');

    await expect(service.walletProvision(payload)).rejects.toThrow(RpcException);
    expect(endpointCheck).not.toHaveBeenCalled();
  });

  it('returns a clean RPC failure when a successful script produces no endpoint file', async () => {
    execMock.mockImplementation((_command, callback) => {
      callback(null, 'Agent is ready', '');
    });
    jest.spyOn(service, 'checkFileExistence').mockResolvedValue(false);

    await expect(service.walletProvision(payload)).rejects.toThrow(RpcException);
  });
});
