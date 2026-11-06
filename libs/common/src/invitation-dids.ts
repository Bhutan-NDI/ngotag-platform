import type { PrismaClient } from '@prisma/client';
import { ORG_AGENT_MIGRATION_POST_CUTOVER_STATUSES } from '@credebl/enum/enum';

// Credo-based holders only check the first invitation DID against their existing connections, so the legacy DID listed
// second does not let them reuse a connection made before the move: they make one new connection, then reuse that.
export interface ReuseInvitationDids {
  invitationDid?: string;
  // Only set for an org that has moved to a dedicated agent: the invitation DID it used before the move, listed
  // second so an existing connection is still recognised by an app that checks every DID.
  additionalInvitationDids?: string[];
}

/**
 * The invitation DID(s) a reuse request (a credential offer, proof request or connection invitation that should
 * reuse an existing connection) must carry for the org.
 *
 * An org whose migration has reached cutover gets the invitation created on its dedicated agent first and its old one
 * second. The choice is read from the migration, not "newest invitation", so creating further invitations later cannot
 * change it. Any other org gets its oldest invitation, as before, and no `additionalInvitationDids`, which agents not
 * yet upgraded would reject as an unknown property.
 */
export async function findReuseInvitationDids(
  prisma: Pick<PrismaClient, 'org_agent_migrations' | 'agent_invitations'>,
  orgId: string
): Promise<ReuseInvitationDids> {
  const migration = await prisma.org_agent_migrations.findFirst({
    where: {
      orgId,
      status: { in: [...ORG_AGENT_MIGRATION_POST_CUTOVER_STATUSES] },
      newInvitationDid: { not: null }
    },
    orderBy: { createDateTime: 'desc' },
    select: { newInvitationDid: true, legacyInvitationDid: true }
  });

  if (migration?.newInvitationDid) {
    // The migration row outlives the wallet: one that was deleted and re-created since the move took its invitations
    // with it, and the new agent would refuse both DIDs.
    const current = await prisma.agent_invitations.findFirst({
      where: { orgId, invitationDid: migration.newInvitationDid },
      select: { id: true }
    });
    if (current) {
      return {
        invitationDid: migration.newInvitationDid,
        additionalInvitationDids: migration.legacyInvitationDid ? [migration.legacyInvitationDid] : undefined
      };
    }
  }

  const oldest = await prisma.agent_invitations.findFirst({
    where: { orgId, invitationDid: { not: null } },
    orderBy: { createDateTime: 'asc' }
  });
  return { invitationDid: oldest?.invitationDid ?? undefined };
}

/** `{ additionalInvitationDids }` when there are any, otherwise nothing, so the key is absent from the payload. */
export function additionalInvitationDidsField(dids: ReuseInvitationDids): { additionalInvitationDids?: string[] } {
  return dids.additionalInvitationDids?.length ? { additionalInvitationDids: dids.additionalInvitationDids } : {};
}
