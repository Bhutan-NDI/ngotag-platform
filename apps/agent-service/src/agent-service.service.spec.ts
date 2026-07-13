import { RpcException } from '@nestjs/microservices';
import { AgentServiceService } from './agent-service.service';

/**
 * Unit tests for AgentServiceService.generateWebDid
 *
 * generateWebDid is the first step of the did:web two-step flow. It calls the
 * agent to compute the DID Document (wallet write, no platform DB write) and
 * returns it so the caller can host it before calling createDid.
 *
 * The guard tested here blocks regeneration when a did:web DID for the given
 * domain is already committed to org_dids — regenerating with a different seed
 * would silently overwrite the Askar wallet key and break signing for the
 * existing DID.
 */
describe('AgentServiceService.generateWebDid', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const domain = 'example.com';
  const expectedDid = `did:web:${domain}`;

  const agentDetails = {
    id: 'agent-id',
    agentEndPoint: 'http://agent:8080',
    orgAgentTypeId: 'dedicated',
    apiKey: 'encrypted-key',
    tenantId: null
  };

  const createPayload = {
    method: 'web' as const,
    keyType: 'ed25519',
    domain,
    seed: 'xZJkv74sWVX28efLHh6U-MsmLDahPmze'
  };

  const mockDidResponse = {
    did: expectedDid,
    didDocument: { id: expectedDid }
  };

  /**
   * Build a minimal AgentServiceService with only the dependencies used
   * by generateWebDid mocked. commonService is passed so httpPost can be
   * spied on in the happy-path tests.
   */
  const buildService = (
    existingDids: { did: string }[] = []
  ): {
    service: AgentServiceService;
    repository: Record<string, jest.Mock>;
    commonService: Record<string, jest.Mock>;
  } => {
    const repository = {
      getOrgAgentDetails: jest.fn().mockResolvedValue(agentDetails),
      getOrgDid: jest.fn().mockResolvedValue(existingDids)
    };

    const commonService = {
      httpPost: jest.fn().mockResolvedValue(mockDidResponse)
    };

    const service = new AgentServiceService(
      repository as never,
      {} as never,
      commonService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    return { service, repository, commonService };
  };

  describe('domain already exists guard', () => {
    it('throws RpcException when a did:web DID for the domain already exists in org_dids', async () => {
      const { service } = buildService([{ did: expectedDid }]);

      await expect(service.generateWebDid(createPayload as never, orgId)).rejects.toThrow(RpcException);
    });

    it('wraps a 400 status and descriptive message in the RpcException', async () => {
      const { service } = buildService([{ did: expectedDid }]);

      try {
        await service.generateWebDid(createPayload as never, orgId);
        fail('expected RpcException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RpcException);
        const payload = (error as RpcException).getError() as { statusCode: number; message: string };
        expect(payload.statusCode).toBe(400);
        expect(payload.message).toContain('already exists');
      }
    });

    it('does not throw when no did:web DID for the domain exists in org_dids', async () => {
      const { service } = buildService([]);
      jest.spyOn(service, 'getOrgAgentApiKey').mockResolvedValue('mock-api-key');

      const result = await service.generateWebDid(createPayload as never, orgId);

      expect(result).toEqual({
        did: expectedDid,
        didDocument: mockDidResponse.didDocument
      });
    });

    it('does not block when org has did:web DIDs for other domains', async () => {
      const { service } = buildService([{ did: 'did:web:other-domain.com' }]);
      jest.spyOn(service, 'getOrgAgentApiKey').mockResolvedValue('mock-api-key');

      const result = await service.generateWebDid(createPayload as never, orgId);

      expect(result).toEqual({
        did: expectedDid,
        didDocument: mockDidResponse.didDocument
      });
    });

    it('queries org_dids with the correct orgId', async () => {
      const { service, repository } = buildService([]);
      jest.spyOn(service, 'getOrgAgentApiKey').mockResolvedValue('mock-api-key');

      await service.generateWebDid(createPayload as never, orgId);

      expect(repository.getOrgDid).toHaveBeenCalledWith(orgId);
    });
  });
});
