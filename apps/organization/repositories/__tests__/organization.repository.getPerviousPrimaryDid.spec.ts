import { OrganizationRepository } from '../organization.repository';

/**
 * Repository-level regression test for the #76 review's [P1] self-demote finding:
 * getPerviousPrimaryDid's Prisma query used to just look up the org's isPrimaryDid: true row
 * with no exclusion, so it could return the very row about to be promoted (id) whenever that row
 * was already (incorrectly) flagged primary -- a pre-existing multi-primary-DID corruption state.
 * setOrgsPrimaryDid would then demote the row it just promoted, in the same transaction, because
 * Prisma's array $transaction runs its operations sequentially.
 *
 * Fixed by scoping the query to exclude the target row's id. This asserts the actual Prisma
 * `where` clause carries that exclusion, and that a null result (no OTHER row is primary) is
 * returned rather than thrown.
 */
describe('OrganizationRepository.getPerviousPrimaryDid', () => {
  const buildRepository = (findFirstResult: unknown): { repository: OrganizationRepository; findFirst: jest.Mock } => {
    const findFirst = jest.fn().mockResolvedValue(findFirstResult);
    // eslint-disable-next-line camelcase
    const prisma = { org_dids: { findFirst } } as unknown as Record<string, unknown>;
    const repository = new OrganizationRepository(prisma as never, { error: jest.fn() } as never, {} as never);
    return { repository, findFirst };
  };

  it('excludes the target row (excludeId) from the isPrimaryDid: true lookup', async () => {
    const { repository, findFirst } = buildRepository({ id: 'previous-did-row' });

    await repository.getPerviousPrimaryDid('org-1', 'org-did-row-1');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        orgId: 'org-1',
        isPrimaryDid: true,
        id: { not: 'org-did-row-1' }
      }
    });
  });

  it('returns null (not a throw) when the target row is the only one currently flagged primary', async () => {
    // The pre-existing multi-primary-DID corruption scenario this exclusion protects against:
    // after excluding the target row, there is genuinely no OTHER primary row left.
    const { repository } = buildRepository(null);

    const result = await repository.getPerviousPrimaryDid('org-1', 'org-did-row-1');

    expect(result).toBeNull();
  });

  it('returns the other org_dids row still flagged primary in the common case', async () => {
    const otherPrimaryRow = { id: 'previous-did-row', isPrimaryDid: true };
    const { repository } = buildRepository(otherPrimaryRow);

    const result = await repository.getPerviousPrimaryDid('org-1', 'org-did-row-1');

    expect(result).toBe(otherPrimaryRow);
  });
});
