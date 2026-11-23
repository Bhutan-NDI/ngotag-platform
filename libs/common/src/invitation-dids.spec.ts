/**
 * Note this repo has no jest step in CI - run with:
 *   npx jest libs/common/src/invitation-dids.spec.ts
 */
/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { additionalInvitationDidsField, findReuseInvitationDids } from './invitation-dids';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const build = (options: { migration?: object | null; oldest?: object | null; current?: object | null } = {}) => {
  const migrationFindFirst = jest.fn().mockResolvedValue(options.migration ?? null);
  // One lookup checks the migration's invitation still belongs to this org's wallet, the other finds the oldest.
  const invitationFindFirst = jest
    .fn()
    .mockImplementation(async ({ where }: { where: { invitationDid?: unknown } }) =>
      'string' === typeof where.invitationDid
        ? 'current' in options
          ? options.current
          : { id: 'inv-1' }
        : (options.oldest ?? null)
    );
  const prisma = {
    org_agent_migrations: { findFirst: migrationFindFirst },
    agent_invitations: { findFirst: invitationFindFirst }
  };
  return { prisma: prisma as never, migrationFindFirst, invitationFindFirst };
};

describe('findReuseInvitationDids', () => {
  it('gives an org past cutover its new invitation first and the old one second', async () => {
    const { prisma, invitationFindFirst } = build({
      migration: { newInvitationDid: 'did:peer:new', legacyInvitationDid: 'did:peer:old' }
    });

    await expect(findReuseInvitationDids(prisma, ORG_ID)).resolves.toEqual({
      invitationDid: 'did:peer:new',
      additionalInvitationDids: ['did:peer:old']
    });
    expect(invitationFindFirst).toHaveBeenCalledTimes(1);
    expect(invitationFindFirst).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, invitationDid: 'did:peer:new' },
      select: { id: true }
    });
  });

  it('falls back to the oldest invitation when the wallet was deleted and re-created since the move', async () => {
    const { prisma } = build({
      migration: { newInvitationDid: 'did:peer:gone', legacyInvitationDid: 'did:peer:old' },
      current: null,
      oldest: { invitationDid: 'did:peer:fresh' }
    });

    const result = await findReuseInvitationDids(prisma, ORG_ID);

    expect(result).toEqual({ invitationDid: 'did:peer:fresh' });
    expect(result).not.toHaveProperty('additionalInvitationDids');
  });

  it('omits the second DID when the migration recorded no legacy one', async () => {
    const { prisma } = build({ migration: { newInvitationDid: 'did:peer:new', legacyInvitationDid: null } });

    await expect(findReuseInvitationDids(prisma, ORG_ID)).resolves.toEqual({
      invitationDid: 'did:peer:new',
      additionalInvitationDids: undefined
    });
  });

  it('only considers the newest migration of this org that has reached cutover and has a new invitation', async () => {
    const { prisma, migrationFindFirst } = build();

    await findReuseInvitationDids(prisma, ORG_ID);

    expect(migrationFindFirst).toHaveBeenCalledWith({
      where: {
        orgId: ORG_ID,
        status: { in: [Status.CUTOVER, Status.STABILISING, Status.ROTATING, Status.COMPLETED] },
        newInvitationDid: { not: null }
      },
      orderBy: { createDateTime: 'desc' },
      select: { newInvitationDid: true, legacyInvitationDid: true }
    });
  });

  it.each([
    Status.CREATED,
    Status.REHEARSED,
    Status.FROZEN,
    Status.EXPORTING,
    Status.IMPORTING,
    Status.VERIFYING,
    Status.FAILED,
    Status.DISASTER_RESTORED
  ])('does not use a migration that is %s', async (status) => {
    const { prisma, migrationFindFirst } = build();

    await findReuseInvitationDids(prisma, ORG_ID);

    expect(migrationFindFirst.mock.calls[0][0].where.status.in).not.toContain(status);
  });

  it('gives any other org its oldest invitation, with no second DID', async () => {
    const { prisma, invitationFindFirst } = build({ oldest: { invitationDid: 'did:peer:oldest' } });

    const result = await findReuseInvitationDids(prisma, ORG_ID);

    expect(result).toEqual({ invitationDid: 'did:peer:oldest' });
    expect(result).not.toHaveProperty('additionalInvitationDids');
    expect(invitationFindFirst).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, invitationDid: { not: null } },
      orderBy: { createDateTime: 'asc' }
    });
  });

  it('gives an org with no invitation at all nothing', async () => {
    const { prisma } = build();

    await expect(findReuseInvitationDids(prisma, ORG_ID)).resolves.toEqual({ invitationDid: undefined });
  });

  it('falls back to the oldest invitation when the migration row has no new invitation DID', async () => {
    const { prisma } = build({
      migration: { newInvitationDid: null, legacyInvitationDid: 'did:peer:old' },
      oldest: { invitationDid: 'did:peer:oldest' }
    });

    await expect(findReuseInvitationDids(prisma, ORG_ID)).resolves.toEqual({ invitationDid: 'did:peer:oldest' });
  });
});

describe('additionalInvitationDidsField', () => {
  it('adds the key only when there is something to send', () => {
    expect(additionalInvitationDidsField({ invitationDid: 'a', additionalInvitationDids: ['b'] })).toEqual({
      additionalInvitationDids: ['b']
    });
    expect(additionalInvitationDidsField({ invitationDid: 'a' })).toEqual({});
    expect(additionalInvitationDidsField({ additionalInvitationDids: [] })).toEqual({});
    expect({ x: 1, ...additionalInvitationDidsField({ invitationDid: 'a' }) }).not.toHaveProperty(
      'additionalInvitationDids'
    );
  });
});
