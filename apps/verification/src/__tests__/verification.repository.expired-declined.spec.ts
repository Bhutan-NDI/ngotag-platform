import { VerificationRepository } from '../repositories/verification.repository';

const ORG_ID = 'org-1';

function search(term: string): { where: Record<string, unknown> } {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const repository = new VerificationRepository(
    { presentations: { findMany, count } } as never,
    {} as never,
    { error: jest.fn() } as never
  );
  return {
    get where(): Record<string, unknown> {
      return findMany.mock.calls[0][0].where;
    },
    run: repository.getAllProofRequests({} as never, ORG_ID, {
      search: term,
      pageNumber: 1,
      pageSize: 10,
      sortField: 'createDateTime',
      sortBy: 'desc'
    } as never)
  } as never;
}

describe('VerificationRepository.getAllProofRequests — Expired vs Declined', () => {
  it('"Expired" matches only abandoned requests carrying the request-expired code', async () => {
    const result = search('Expired') as unknown as { run: Promise<unknown>; where: unknown };
    await result.run;
    expect(result.where).toEqual({
      orgId: ORG_ID,
      state: 'abandoned',
      errorMessage: { startsWith: 'request-expired' }
    });
  });

  it('"Declined" matches abandoned requests without the request-expired code, including a null errorMessage', async () => {
    const result = search('declined') as unknown as { run: Promise<unknown>; where: unknown };
    await result.run;
    expect(result.where).toEqual({
      orgId: ORG_ID,
      state: 'abandoned',
      OR: [{ errorMessage: null }, { NOT: { errorMessage: { startsWith: 'request-expired' } } }]
    });
  });

  it('any other search keeps the free-text filter', async () => {
    const result = search('Verified') as unknown as { run: Promise<unknown>; where: { orgId: string; OR: unknown[] } };
    await result.run;
    expect(result.where.orgId).toBe(ORG_ID);
    expect(result.where.OR).toEqual(expect.arrayContaining([{ state: { contains: 'done', mode: 'insensitive' } }]));
  });
});
