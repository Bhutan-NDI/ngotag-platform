/**
 * Regression test for a production ledger-mismatch bug (this is the "Trigger A" half of two
 * confirmed causes; see the sibling fix on agent-service.service.ts's createDid, "Trigger B").
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
 * Also covers the #76 review's follow-up findings on this same method:
 *  - the caller-supplied `id` is now validated against the org_dids row that (orgId, did)
 *    actually resolves to, instead of being trusted blindly (a cross-tenant id-mismatch bug);
 *  - demoting the previous primary DID now happens inside setOrgsPrimaryDid's own transaction
 *    (via previousDidId), instead of as a separate write that ran before it.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) — apps/organization has no
 * existing spec files to follow a local convention from, so this mirrors the pattern already
 * established in apps/agent-service/src/agent-service.service.spec.ts: only the dependencies
 * setPrimaryDid actually calls are mocked.
 */
import { OrganizationService } from '../organization.service';

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_DID_ID = 'org-did-row-1';
const OTHER_ORGS_DID_ID = 'org-did-row-belonging-to-a-different-org';
const PREVIOUS_DID_ID = 'previous-did-row';

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
    getDidDetailsByDid: jest.fn().mockResolvedValue({ id: ORG_DID_ID, didDocument: { id: did } }),
    getDids: jest.fn().mockResolvedValue([{ did: 'did:polygon:testnet:0xOtherDid', isPrimaryDid: true }]),
    getPerviousPrimaryDid: jest.fn().mockResolvedValue({ id: PREVIOUS_DID_ID }),
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

    await service.setPrimaryDid(ORG_ID, did, ORG_DID_ID);

    expect(organizationRepository.getNetworkByNameSpace).toHaveBeenCalledWith('ethr:sepolia');
    expect(organizationRepository.getLedger).not.toHaveBeenCalled();
    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ networkId: ETHR_SEPOLIA_LEDGER.id })
    );
  });

  it('resolves the ledger to the mainnet row for a did:ethr DID with no testnet segment', async () => {
    const did = 'did:ethr:0xabcdef1234567890abcdef1234567890abcdef12';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, ORG_DID_ID);

    expect(organizationRepository.getNetworkByNameSpace).toHaveBeenCalledWith('ethr:mainnet');
    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ networkId: ETHR_MAINNET_LEDGER.id })
    );
  });

  it('still falls back to Not_Applicable for a did:key DID, unaffected by this fix', async () => {
    const did = 'did:key:z6Mkabcdefghijklmnopqrstuvwxyz1234567890AB';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, ORG_DID_ID);

    expect(organizationRepository.getNetworkByNameSpace).not.toHaveBeenCalled();
    expect(organizationRepository.getLedger).toHaveBeenCalled();
    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ networkId: NOT_APPLICABLE_LEDGER.id })
    );
  });

  it('still resolves indy/polygon namespaces exactly as before (untouched by this fix)', async () => {
    const did = 'did:polygon:testnet:0xabcdef1234567890abcdef1234567890abcdef12';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, ORG_DID_ID);

    expect(organizationRepository.getNetworkByNameSpace).toHaveBeenCalledWith('polygon:testnet');
  });

  it("does not demote the existing primary DID when the new one's ledger cannot be resolved -- the org must not end up with no primary DID at all", async () => {
    // #76 review (P1): getNetworkByNameSpace uses findFirstOrThrow, so it throws outright if the
    // resolved namespace has no matching row (e.g. the ethr:* seed migration hasn't run in this
    // environment, or the row was otherwise removed) -- reproduced here by forcing the same
    // namespace this DID would normally resolve to (ethr:sepolia) to reject instead of resolve.
    // Resolving the ledger BEFORE building primaryDidDetails (which is what now carries the
    // demotion through to setOrgsPrimaryDid's transaction) means that throw aborts the whole call
    // before any write happens at all -- the org keeps its current primary DID untouched.
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    const { service, organizationRepository } = buildService(did);
    organizationRepository.getNetworkByNameSpace.mockRejectedValue(
      new Error('no ledger seeded for namespace ethr:sepolia')
    );

    await expect(service.setPrimaryDid(ORG_ID, did, ORG_DID_ID)).rejects.toThrow();

    expect(organizationRepository.setOrgsPrimaryDid).not.toHaveBeenCalled();
  });
});

describe('OrganizationService.setPrimaryDid — id/did/orgId validation and atomic demotion (#76 review)', () => {
  it('rejects a caller-supplied id that does not match the org_dids row this did/orgId pair resolves to', async () => {
    // Cross-tenant bug: getDidDetailsByDid resolves the row from (orgId, did) alone, but the row
    // actually updated is looked up by the caller-supplied `id`. Without this check, a caller who
    // supplies a did/orgId that legitimately belongs to their own org, but an `id` referencing a
    // DIFFERENT org's org_dids row, would flip isPrimaryDid on that other org's row instead.
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    const { service, organizationRepository } = buildService(did);

    await expect(service.setPrimaryDid(ORG_ID, did, OTHER_ORGS_DID_ID)).rejects.toThrow();

    expect(organizationRepository.setOrgsPrimaryDid).not.toHaveBeenCalled();
  });

  it('demotes the previous primary DID atomically with the promotion, by passing previousDidId through to setOrgsPrimaryDid rather than writing it separately beforehand', async () => {
    // The old code called a separate setPreviousDidFlase(existingPrimaryDid.id) write BEFORE
    // setOrgsPrimaryDid's own transaction ran -- if setOrgsPrimaryDid then failed (an invalid row
    // id, a uniqueness conflict, a transient DB error), the org was left with its previous DID
    // already demoted and no replacement, i.e. no primary DID at all. That separate call is gone;
    // the demotion now travels as previousDidId, inside the SAME call whose repository
    // implementation wraps it in one $transaction (see organization.repository.spec assertions for
    // the transaction itself -- this test only verifies the service passes the right id through).
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, ORG_DID_ID);

    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ previousDidId: PREVIOUS_DID_ID })
    );
  });

  it('omits previousDidId when the org has no existing primary DID to demote', async () => {
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    const { service, organizationRepository } = buildService(did);
    organizationRepository.getDids.mockResolvedValue([{ did: 'did:polygon:testnet:0xOtherDid', isPrimaryDid: false }]);

    await service.setPrimaryDid(ORG_ID, did, ORG_DID_ID);

    expect(organizationRepository.getPerviousPrimaryDid).not.toHaveBeenCalled();
    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ previousDidId: undefined })
    );
  });

  it('excludes the row being promoted from the previous-primary-DID lookup, by id', async () => {
    // getPerviousPrimaryDid must be called with the target id so the repository can exclude it --
    // see the #76 review's self-demote finding below for what goes wrong if it isn't.
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    const { service, organizationRepository } = buildService(did);

    await service.setPrimaryDid(ORG_ID, did, ORG_DID_ID);

    expect(organizationRepository.getPerviousPrimaryDid).toHaveBeenCalledWith(ORG_ID, ORG_DID_ID);
  });

  it('does not demote the row it just promoted, when that row is already (incorrectly) flagged primary', async () => {
    // #76 review (P1): a pre-existing "multi-primary-DID" corruption state (more than one
    // org_dids row flagged isPrimaryDid: true for the org -- exactly what the v2.2.0 runbook's
    // DAT-1 step remediates via this same endpoint) can mean the row being promoted (id) is
    // ALREADY flagged primary. Without excluding it, getPerviousPrimaryDid would return that same
    // row as "the previous primary DID", making previousDidId === id -- setOrgsPrimaryDid's
    // transaction would then run two org_dids.update({ where: { id } }) operations (promote, then
    // demote), and since Prisma's array $transaction runs them sequentially, the demote wins,
    // leaving the row org_agents now points at flagged NOT primary.
    //
    // With the id-excluding lookup, the repository correctly reports "no OTHER primary row"
    // (null) in this scenario, so previousDidId must come through undefined -- nothing else to
    // demote.
    const did = 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678';
    const { service, organizationRepository } = buildService(did);
    organizationRepository.getPerviousPrimaryDid.mockResolvedValue(null);

    await service.setPrimaryDid(ORG_ID, did, ORG_DID_ID);

    expect(organizationRepository.setOrgsPrimaryDid).toHaveBeenCalledWith(
      expect.objectContaining({ previousDidId: undefined })
    );
  });
});
