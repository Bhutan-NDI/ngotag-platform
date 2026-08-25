import { OrganizationRepository } from '../organization.repository';

/**
 * Repository-level regression test for the #76 review's [P1] atomicity finding:
 * setOrgsPrimaryDid used to run alongside a SEPARATE, earlier setPreviousDidFlase() write that
 * committed independently, before this transaction even started. If setOrgsPrimaryDid's own
 * transaction then failed, the org was left with its previous primary DID already demoted and no
 * replacement -- no primary DID at all.
 *
 * setPreviousDidFlase() is gone; the demotion now travels in as `previousDidId` and is included,
 * conditionally, as an operation inside setOrgsPrimaryDid's own `$transaction([...])` array. These
 * tests assert that shape directly against a mocked PrismaService: exactly one `$transaction`
 * call carrying all the writes that must succeed or fail together, and no `org_dids.update` call
 * made outside of it.
 *
 * The demotion must be the FIRST operation, ahead of the promotion, to satisfy the
 * org_dids_one_primary_per_org_unique partial unique index (mocked here, so this only pins the
 * order -- see organization.repository.ts for why it matters).
 */
describe('OrganizationRepository.setOrgsPrimaryDid', () => {
  const primaryDidDetails = {
    id: 'org-did-row-1',
    orgId: '00000000-0000-0000-0000-000000000001',
    did: 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678',
    didDocument: { id: 'did:ethr:sepolia:0x1234567890abcdef1234567890abcdef12345678' },
    networkId: 'ledger-ethr-sepolia'
  };

  const buildRepository = (
    transactionImpl: (ops: unknown[]) => unknown
  ): { repository: OrganizationRepository; prisma: Record<string, jest.Mock> } => {
    // eslint-disable-next-line camelcase
    const org_dids = { update: jest.fn((args: unknown) => ({ __op: 'org_dids.update', args })) };
    // eslint-disable-next-line camelcase
    const org_agents = { update: jest.fn((args: unknown) => ({ __op: 'org_agents.update', args })) };
    const $transaction = jest.fn(transactionImpl);
    // eslint-disable-next-line camelcase
    const prisma = { org_dids, org_agents, $transaction } as unknown as Record<string, jest.Mock>;
    const repository = new OrganizationRepository(prisma as never, { error: jest.fn() } as never, {} as never);
    return { repository, prisma };
  };

  it('demotes the previous primary DID inside the SAME $transaction call as the promotion and the org_agents update', async () => {
    const { repository, prisma } = buildRepository((ops) => Promise.resolve(ops));

    await repository.setOrgsPrimaryDid({ ...primaryDidDetails, previousDidId: 'previous-did-row' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const operations = prisma.$transaction.mock.calls[0][0] as { __op: string }[];
    expect(operations.map((op) => op.__op)).toEqual(['org_dids.update', 'org_dids.update', 'org_agents.update']);
    expect((prisma.org_dids as unknown as { update: jest.Mock }).update).toHaveBeenNthCalledWith(1, {
      where: { id: 'previous-did-row' },
      data: { isPrimaryDid: false }
    });
  });

  it('orders the demotion BEFORE the promotion -- promoting first would trip org_dids_one_primary_per_org_unique', async () => {
    const { repository, prisma } = buildRepository((ops) => Promise.resolve(ops));

    await repository.setOrgsPrimaryDid({ ...primaryDidDetails, previousDidId: 'previous-did-row' });

    const updateCalls = (prisma.org_dids as unknown as { update: jest.Mock }).update.mock.calls;
    expect(updateCalls[0][0]).toEqual({ where: { id: 'previous-did-row' }, data: { isPrimaryDid: false } });
    expect(updateCalls[1][0]).toEqual({ where: { id: primaryDidDetails.id }, data: { isPrimaryDid: true } });
  });

  it('omits the demotion operation entirely when there is no previous primary DID (previousDidId undefined)', async () => {
    const { repository, prisma } = buildRepository((ops) => Promise.resolve(ops));

    await repository.setOrgsPrimaryDid(primaryDidDetails);

    const operations = prisma.$transaction.mock.calls[0][0] as { __op: string }[];
    expect(operations).toHaveLength(2);
    expect((prisma.org_dids as unknown as { update: jest.Mock }).update).toHaveBeenCalledTimes(1);
  });

  it('leaves the previous primary DID demoted nowhere if the transaction itself fails -- no write happens outside of it', async () => {
    // Simulates the exact failure the reviewer asked to be covered: a promotion failure (e.g. an
    // invalid row id, a uniqueness conflict, a transient DB error) inside the transaction.
    // Because the demotion is now an operation WITHIN that same $transaction call rather than a
    // prior, separately-committed write, Prisma guarantees none of the three operations persist --
    // there is no code path here that could commit the demotion on its own.
    const { repository, prisma } = buildRepository(() => Promise.reject(new Error('unique constraint violated')));

    await expect(
      repository.setOrgsPrimaryDid({ ...primaryDidDetails, previousDidId: 'previous-did-row' })
    ).rejects.toThrow('unique constraint violated');

    // The two update() calls above only ever BUILD PrismaPromise operation descriptors passed
    // into $transaction -- they do not execute independently, so there is no separate demote
    // write left to have "already happened" when $transaction rejects.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
