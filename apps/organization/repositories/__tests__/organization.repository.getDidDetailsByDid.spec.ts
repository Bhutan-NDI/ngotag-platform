import { OrganizationRepository } from '../organization.repository';

/**
 * Repository-level regression test for the #76 review's [P2] test-coverage finding: the earlier
 * review round's orgId-scoping fix (closing a cross-tenant id-mismatch bug -- a did/orgId pair
 * that legitimately belongs to the caller's own org, paired with an `id` referencing a DIFFERENT
 * org's row, could otherwise flip isPrimaryDid on that other org's row) was only ever exercised
 * through a service-level mock that ignores its (orgId, did) arguments entirely. A future
 * regression here (e.g. someone dropping the orgId filter during a refactor) would pass that
 * suite silently while reopening the cross-tenant bug. This asserts the real Prisma `where`
 * clause directly.
 */
describe('OrganizationRepository.getDidDetailsByDid', () => {
  it('scopes the lookup by both orgId and did', async () => {
    const findFirstOrThrow = jest.fn().mockResolvedValue({ id: 'org-did-row-1' });
    // eslint-disable-next-line camelcase
    const prisma = { org_dids: { findFirstOrThrow } } as unknown as Record<string, unknown>;
    const repository = new OrganizationRepository(prisma as never, { error: jest.fn() } as never, {} as never);

    await repository.getDidDetailsByDid('org-1', 'did:ethr:sepolia:0xabc');

    expect(findFirstOrThrow).toHaveBeenCalledWith({
      where: {
        orgId: 'org-1',
        did: 'did:ethr:sepolia:0xabc'
      }
    });
  });
});
