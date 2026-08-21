/**
 * Regression test for a production ledger-mismatch bug (Trigger A of the two confirmed causes;
 * see LEDGER-MISMATCH-BUG-CONTEXT.md and the sibling fix on agent-service.service.ts's createDid,
 * Trigger B).
 *
 * setPrimaryDid's ledger-namespace resolution only had an INDY branch and a POLYGON branch;
 * DidMethod.ETHEREUM ('ethr') fell through to the `else` and forced org_agents.ledgerId to the
 * Not_Applicable placeholder regardless of the DID's real network — confirmed in production,
 * deterministically, every time a did:ethr DID was set primary through this endpoint (e.g. via
 * the v2.2.0 migration runbook's DAT-1 multi-primary-DID remediation step). That diverges from
 * schema.ledgerId (resolved from the same did:ethr string via networkNamespace() in
 * schema.service.ts's updateW3CSchemas), which the pre-existing ledger-mismatch guard in
 * issuance.service.ts then rejects on the next issuance attempt. Fixed by adding an explicit
 * did:ethr branch that reuses the same networkNamespace() helper, instead of falling through to
 * Not_Applicable.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) — apps/organization has no
 * existing spec files to follow a local convention from, so this mirrors the pattern already
 * established in apps/agent-service/src/agent-service.service.spec.ts and this session's
 * cloud-wallet specs: only the dependencies setPrimaryDid actually calls are mocked.
 */
import { OrganizationService } from '../organization.service';

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = 'user-1';

const ETHR_SEPOLIA_LEDGER = { id: 'ledger-ethr-sepolia', indyNamespace: 'ethr:sepolia' };
const ETHR_MAINNET_LEDGER = { id: 'ledger-ethr-mainnet', indyNamespace: 'ethr:mainnet' };
const NOT_APPLICABLE_LEDGER = { id: 'ledger-not-applicable', indyNamespace: null };
const POLYGON_TESTNET_LEDGER = { id: 'ledger-polygon-testnet', indyNamespace: 'polygon:testnet' };

function buildService(did: string): {
  service: OrganizationService;
  organizationRepository: Record<string, jest.Mock>;
} {
  const organizationRepository = {
    getOrgProfile: jest.fn().mockResolvedValue({ id: ORG_ID }),
    getAgentEndPoint: jest.fn().mockResolvedValue({ orgDid: 'did:polygon:testnet:0xOtherDid' }),
    getAllOrganizationDid: jest.fn().mockResolvedValue([{ did }]),
    getDidDetailsByDid: jest.fn().mockResolvedValue({ didDocument: { id: did } }),
    getDids: jest.fn().mockResolvedValue([{ did: 'did:polygon:testnet:0xOtherDid', isPrimaryDid: true }]),
    getPerviousPrimaryDid: jest.fn().mockResolvedValue({ id: 'previous-did-row' }),
    setPreviousDidFlase: jest.fn().mockResolvedValue(undefined),
    getNetworkByNameSpace: jest.fn((namespace: string) => {
      if ('ethr:sepolia' === namespace) {
        return Promise.resolve(ETHR_SEPOLIA_LEDGER);
      }
      if ('ethr:mainnet' === namespace) {
        return Promise.resolve(ETHR_MAINNET_LEDGER);
      }
      if ('polygon:testnet' === namespace) {
        return Promise.resolve(POLYGON_TESTNET_LEDGER);
      }
      return Promise.reject(new Error(`no ledger seeded for namespace ${namespace}`));
    }),
    getLedger: jest.fn().mockResolvedValue(NOT_APPLICABLE_LEDGER),
    setOrgsPrimaryDid: jest.fn().mockResolvedValue(undefined)
  };

  // Positional constructor args: only organizationRepository (4th) and logger (9th) matter here —
  // logger is unused by the success path but the class assumes it exists.
  const service = new OrganizationService(
    {} as never,
    {} as never,
    {} as never,
    organizationRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );

  return { service, organizationRepository };
}

describe('OrganizationService.setPrimaryDid — ledger resolution for a did:ethr DID', () => {
  it('resolves the ledger via networkNamespace(did) for did:ethr:sepolia, not the Not_Applicable placeholder', async () => {
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, USER_ID);

    expect(organizationRepository.getNetworkByNameSpace).toHaveBeenCalledWith('ethr:sepolia');
    expect(organizationRepository.getLedger).not.toHaveBeenCalled();
    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ networkId: ETHR_SEPOLIA_LEDGER.id })
    );
  });

  it('resolves the ledger to the mainnet row for a did:ethr DID with no testnet segment', async () => {
    const did = 'did:ethr:0xabcdef1234567890abcdef1234567890abcdef12';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, USER_ID);

    expect(organizationRepository.getNetworkByNameSpace).toHaveBeenCalledWith('ethr:mainnet');
    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ networkId: ETHR_MAINNET_LEDGER.id })
    );
  });

  it('still falls back to Not_Applicable for a did:key DID, unaffected by this fix', async () => {
    const did = 'did:key:z6Mkabcdefghijklmnopqrstuvwxyz1234567890AB';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, USER_ID);

    expect(organizationRepository.getNetworkByNameSpace).not.toHaveBeenCalled();
    expect(organizationRepository.getLedger).toHaveBeenCalled();
    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ networkId: NOT_APPLICABLE_LEDGER.id })
    );
  });

  it('still resolves indy/polygon namespaces exactly as before (untouched by this fix)', async () => {
    const did = 'did:polygon:testnet:0xabcdef1234567890abcdef1234567890abcdef12';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, USER_ID);

    expect(organizationRepository.getNetworkByNameSpace).toHaveBeenCalledWith('polygon:testnet');
  });
});
