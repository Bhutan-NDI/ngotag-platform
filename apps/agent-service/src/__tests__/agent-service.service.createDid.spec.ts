/**
 * Regression test for a production ledger-mismatch bug (this is the "Trigger B" half of two
 * confirmed causes; see the sibling fix on organization.service.ts's setPrimaryDid, "Trigger A").
 *
 * `network` is optional on CreateDidDto for every method, not just did:ethr. createDid's own
 * ledgerId-resolution block only had two cases: "network was supplied" (resolve normally) and
 * "network was not supplied" (fall back to the Not_Applicable/no-ledger placeholder). A did:ethr
 * primary DID created without an explicit network field therefore had org_agents.ledgerId set to
 * Not_Applicable instead of the DID's real network — diverging from schema.ledgerId (resolved
 * from the same did:ethr string via networkNamespace() in schema.service.ts's updateW3CSchemas),
 * which the pre-existing ledger-mismatch guard in issuance.service.ts then rejects on the next
 * issuance attempt. Fixed by adding an explicit did:ethr branch that resolves the ledger from the
 * DID's own namespace (via getLedgerByNameSpace(networkNamespace(did))), the same way the schema
 * side already does, instead of falling through to Not_Applicable.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) — same pattern as the existing
 * agent-service.service.spec.ts.
 */
import { AgentServiceService } from '../agent-service.service';

const ORG_ID = '00000000-0000-0000-0000-000000000001';

const agentDetails = {
  id: 'agent-id',
  agentEndPoint: 'http://agent:8080',
  orgAgentTypeId: 'dedicated',
  apiKey: 'encrypted-key',
  ledgerId: null,
  tenantId: null
};

const ETHR_SEPOLIA_LEDGER = { id: 'ledger-ethr-sepolia', indyNamespace: 'ethr:sepolia' };
const ETHR_MAINNET_LEDGER = { id: 'ledger-ethr-mainnet', indyNamespace: 'ethr:mainnet' };
const NOT_APPLICABLE_LEDGER = { id: 'ledger-not-applicable', indyNamespace: null };

function buildService(
  overrides: {
    getLedgerByNameSpaceImpl?: jest.Mock;
    agent?: Partial<typeof agentDetails> & { orgDid?: string | null };
  } = {}
): {
  service: AgentServiceService;
  repository: Record<string, jest.Mock>;
} {
  const repository = {
    getOrgAgentDetails: jest.fn().mockResolvedValue({ ...agentDetails, ...overrides.agent }),
    getLedgerByNameSpace:
      overrides.getLedgerByNameSpaceImpl ??
      jest.fn((namespace: string) => {
        if ('ethr:sepolia' === namespace) {
          return Promise.resolve(ETHR_SEPOLIA_LEDGER);
        }
        if ('ethr:mainnet' === namespace) {
          return Promise.resolve(ETHR_MAINNET_LEDGER);
        }
        return Promise.reject(new Error(`no ledger seeded for namespace ${namespace}`));
      }),
    getLedger: jest.fn().mockResolvedValue(NOT_APPLICABLE_LEDGER),
    getOrgDid: jest.fn().mockResolvedValue([]),
    persistDidWithUpdates: jest.fn().mockResolvedValue({ id: 'org-did-1' })
  };

  const service = new AgentServiceService(
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
  jest.spyOn(service, 'getOrgAgentApiKey').mockResolvedValue('mock-api-key');

  return { service, repository };
}

function mockAgentDidResponse(service: AgentServiceService, did: string): void {
  const castService = service as unknown as { getDidDetails: (...args: unknown[]) => Promise<object> };
  jest.spyOn(castService, 'getDidDetails').mockResolvedValue({ did, didDocument: { id: did } });
}

describe('AgentServiceService.createDid — ledger resolution for a did:ethr primary DID with no explicit network', () => {
  it('resolves org_agents.ledgerId via networkNamespace(did) for a did:ethr:sepolia primary DID, not Not_Applicable', async () => {
    const { service, repository } = buildService();
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    mockAgentDidResponse(service, did);

    await service.createDid({ method: 'ethr', keyType: 'secp256k1', isPrimaryDid: true } as never, ORG_ID, {
      id: 'user-1'
    } as never);

    expect(repository.getLedgerByNameSpace).toHaveBeenCalledWith('ethr:sepolia');
    expect(repository.getLedger).not.toHaveBeenCalled();
    expect(repository.persistDidWithUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerId: ETHR_SEPOLIA_LEDGER.id })
    );
  });

  it('resolves org_agents.ledgerId to the mainnet row for a did:ethr DID with no testnet segment', async () => {
    const { service, repository } = buildService();
    const did = 'did:ethr:0xabcdef1234567890abcdef1234567890abcdef12';
    mockAgentDidResponse(service, did);

    await service.createDid({ method: 'ethr', keyType: 'secp256k1', isPrimaryDid: true } as never, ORG_ID, {
      id: 'user-1'
    } as never);

    expect(repository.getLedgerByNameSpace).toHaveBeenCalledWith('ethr:mainnet');
    expect(repository.persistDidWithUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerId: ETHR_MAINNET_LEDGER.id })
    );
  });

  it('still falls back to Not_Applicable for a non-ethereum method with no network, unaffected by this fix', async () => {
    const { service, repository } = buildService();
    const did = 'did:key:z6Mk...';
    mockAgentDidResponse(service, did);

    await service.createDid({ method: 'key', keyType: 'ed25519', isPrimaryDid: true } as never, ORG_ID, {
      id: 'user-1'
    } as never);

    expect(repository.getLedgerByNameSpace).not.toHaveBeenCalled();
    expect(repository.getLedger).toHaveBeenCalled();
    expect(repository.persistDidWithUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerId: NOT_APPLICABLE_LEDGER.id })
    );
  });

  it('does not attempt a ledger lookup at all when the DID is not primary', async () => {
    const { service, repository } = buildService();
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    mockAgentDidResponse(service, did);

    await service.createDid({ method: 'ethr', keyType: 'secp256k1', isPrimaryDid: false } as never, ORG_ID, {
      id: 'user-1'
    } as never);

    expect(repository.getLedgerByNameSpace).not.toHaveBeenCalled();
    expect(repository.getLedger).not.toHaveBeenCalled();
    expect(repository.persistDidWithUpdates).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: null }));
  });

  it('falls back to Not_Applicable, and still persists the DID, when the ethr namespace has no seeded ledger row', async () => {
    // #76 review (P2): getLedgerByNameSpace uses findFirstOrThrow, so it can genuinely throw for a
    // legitimate ethr DID (e.g. an unseeded/unexpected network segment) -- unlike the fixed
    // Not_Applicable lookup, whose target row always exists. By this point in createDid, the DID
    // has ALREADY been created on-chain/in the agent (mockAgentDidResponse stands in for that
    // call having already succeeded). If this throw were allowed to propagate, persistDidWithUpdates
    // would never run, leaving that on-chain DID with no corresponding org_dids/org_agents row and
    // no reconciliation path. It must fall back to Not_Applicable and still persist instead.
    const { service, repository } = buildService({
      getLedgerByNameSpaceImpl: jest.fn().mockRejectedValue(new Error('no ledger seeded for namespace ethr:sepolia'))
    });
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    mockAgentDidResponse(service, did);

    await service.createDid({ method: 'ethr', keyType: 'secp256k1', isPrimaryDid: true } as never, ORG_ID, {
      id: 'user-1'
    } as never);

    expect(repository.getLedger).toHaveBeenCalled();
    expect(repository.persistDidWithUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerId: NOT_APPLICABLE_LEDGER.id })
    );
  });
});

describe("AgentServiceService.createDid — network check against the org's own network", () => {
  const LEDGERS: Record<string, { id: string; indyNamespace: string }> = {
    'polygon:testnet': { id: 'ledger-polygon-testnet', indyNamespace: 'polygon:testnet' },
    'polygon:mainnet': { id: 'ledger-polygon-mainnet', indyNamespace: 'polygon:mainnet' },
    'ethr:sepolia': ETHR_SEPOLIA_LEDGER,
    'ethr:mainnet': ETHR_MAINNET_LEDGER,
    'bcovrin:testnet': { id: 'ledger-bcovrin-testnet', indyNamespace: 'bcovrin:testnet' },
    'indicio:testnet': { id: 'ledger-indicio-testnet', indyNamespace: 'indicio:testnet' },
    'indicio:mainnet': { id: 'ledger-indicio-mainnet', indyNamespace: 'indicio:mainnet' }
  };
  function findLedger(namespace: string): Promise<{ id: string; indyNamespace: string }> {
    return LEDGERS[namespace]
      ? Promise.resolve(LEDGERS[namespace])
      : Promise.reject(new Error(`unseeded ${namespace}`));
  }

  async function createDid(
    agent: { orgDid: string | null; ledgerId: string | null },
    request: { method: string; network: string },
    createdDid: string
  ): Promise<{ result: Promise<object>; service: AgentServiceService; repository: Record<string, jest.Mock> }> {
    const { service, repository } = buildService({ agent, getLedgerByNameSpaceImpl: jest.fn(findLedger) });
    mockAgentDidResponse(service, createdDid);
    const result = service.createDid({ ...request, keyType: 'secp256k1', isPrimaryDid: false } as never, ORG_ID, {
      id: 'user-1'
    } as never);
    return { result, service, repository };
  }

  function agentCall(service: AgentServiceService): jest.Mock {
    return (service as unknown as { getDidDetails: jest.Mock }).getDidDetails;
  }

  it.each([
    [
      'an indy DID on a test network for an org whose did:polygon primary DID is on a test network',
      { orgDid: 'did:polygon:testnet:0xissuer', ledgerId: 'ledger-polygon-testnet' },
      { method: 'indy', network: 'bcovrin:testnet' }
    ],
    [
      'a polygon DID for an org whose did:ethr primary DID is stored on no_ledger',
      { orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: 'ledger-not-applicable' },
      { method: 'polygon', network: 'polygon:testnet' }
    ],
    [
      'a polygon DID for an org whose primary DID is did:ethr',
      { orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: ETHR_SEPOLIA_LEDGER.id },
      { method: 'polygon', network: 'polygon:testnet' }
    ],
    [
      "a polygon DID on the network of the org's did:polygon primary DID, whose stored ledger is NULL",
      { orgDid: 'did:polygon:testnet:0xissuer', ledgerId: null },
      { method: 'polygon', network: 'polygon:testnet' }
    ],
    [
      "a polygon DID on the network of the org's did:polygon primary DID, whose stored ledger is stale",
      { orgDid: 'did:polygon:testnet:0xissuer', ledgerId: 'ledger-not-applicable' },
      { method: 'polygon', network: 'polygon:testnet' }
    ],
    [
      "a polygon DID on the network of the org's mainnet did:polygon primary DID",
      { orgDid: 'did:polygon:0xissuer', ledgerId: null },
      { method: 'polygon', network: 'polygon:mainnet' }
    ],
    [
      "an ethr DID on another network than the org's did:ethr primary DID (ethr stays exempt)",
      { orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: ETHR_SEPOLIA_LEDGER.id },
      { method: 'ethr', network: 'ethr:mainnet' }
    ],
    [
      'a polygon DID for an org with no primary DID and no stored ledger',
      { orgDid: null, ledgerId: null },
      { method: 'polygon', network: 'polygon:testnet' }
    ],
    [
      'a polygon DID for an org with no primary DID on the stored ledger',
      { orgDid: null, ledgerId: 'ledger-polygon-testnet' },
      { method: 'polygon', network: 'polygon:testnet' }
    ]
  ])('creates %s', async (_label, agent, request) => {
    const { result, service, repository } = await createDid(agent, request, `did:${request.method}:new`);

    await expect(result).resolves.toBeDefined();
    expect(agentCall(service)).toHaveBeenCalledTimes(1);
    expect(repository.persistDidWithUpdates).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an indy DID on a mainnet for an org whose did:polygon primary DID is on a test network',
      { orgDid: 'did:polygon:testnet:0xissuer', ledgerId: 'ledger-polygon-testnet' },
      { method: 'indy', network: 'indicio:mainnet' }
    ],
    [
      'a polygon DID on a test network for an org whose did:indy primary DID is on a mainnet',
      { orgDid: 'did:indy:indicio:mainnet:issuer', ledgerId: 'ledger-indicio-mainnet' },
      { method: 'polygon', network: 'polygon:testnet' }
    ],
    [
      'a polygon DID on a mainnet for an org whose did:ethr primary DID is on a test network',
      { orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: ETHR_SEPOLIA_LEDGER.id },
      { method: 'polygon', network: 'polygon:mainnet' }
    ],
    [
      "a polygon DID on another network than the org's did:polygon primary DID",
      { orgDid: 'did:polygon:testnet:0xissuer', ledgerId: 'ledger-polygon-testnet' },
      { method: 'polygon', network: 'polygon:mainnet' }
    ],
    [
      "a polygon DID on another network than the org's mainnet did:polygon primary DID, even with a stale stored ledger",
      { orgDid: 'did:polygon:0xissuer', ledgerId: 'ledger-polygon-testnet' },
      { method: 'polygon', network: 'polygon:testnet' }
    ],
    [
      "an indy DID on another ledger than the org's did:indy primary DID",
      { orgDid: 'did:indy:bcovrin:testnet:issuer', ledgerId: null },
      { method: 'indy', network: 'indicio:testnet' }
    ],
    [
      'a polygon DID off the stored ledger of an org with no primary DID',
      { orgDid: null, ledgerId: 'ledger-polygon-testnet' },
      { method: 'polygon', network: 'polygon:mainnet' }
    ]
  ])('rejects %s before calling the agent', async (_label, agent, request) => {
    const { result, service, repository } = await createDid(agent, request, `did:${request.method}:new`);

    await expect(result).rejects.toBeDefined();
    await result.catch((error) => expect(JSON.stringify(error)).toContain('The network is mismatched.'));
    expect(agentCall(service)).not.toHaveBeenCalled();
    expect(repository.persistDidWithUpdates).not.toHaveBeenCalled();
  });
});
