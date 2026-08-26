import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@credebl/prisma-service';
import { CloudWalletType } from '@credebl/enum/enum';
import { ResponseMessages } from '@credebl/common/response-messages';
// eslint-disable-next-line camelcase
import { cloud_wallet_user_info, user } from '@prisma/client';
import {
  ICloudWalletDetails,
  IGetStoredWalletInfo,
  IStoredWalletDetails,
  IStoreWalletInfo
} from '@credebl/common/interfaces/cloud-wallet.interface';

@Injectable()
export class CloudWalletRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger
  ) {}

  // Resolves the SPECIFIC base wallet a tenant actually lives on, not an arbitrary active one.
  // There is no baseWalletId FK linking a SUB_WALLET row back to the BASE_WALLET row it was
  // created against (see the capacity-counter comment above), so agentEndpoint -- the value
  // createCloudWallet copied onto the tenant's own row from whichever base wallet it used -- is
  // the only thing that ties the two together. Returns null rather than throwing so callers can
  // produce their own not-found error. See the #71 review's "_commonCloudWalletInfo picks an
  // arbitrary base wallet" finding.
  //
  // Also doubles as configureBaseWallet's duplicate-registration guard (query by agentEndpoint
  // alone, no isActive/type-of-caller filter needed there either -- see below).
  //
  // No isActive filter: this resolves a SPECIFIC, already-known base wallet (either "the one this
  // tenant lives on" or "the one this agentEndpoint already belongs to"), not a candidate for NEW
  // placement -- that distinction is getAvailableBaseWallet's job, and its own isActive filter
  // stays. Filtering isActive here meant deactivating a base wallet (PATCH /base-wallet/:walletId
  // { isActive: false }, intended as "stop placing new tenants here") immediately 404'd every
  // existing tenant's whole wallet API instead: export/import/status/delete/credentials/proofs/
  // connections all resolve their base wallet through this method. See the #71 review's
  // "deactivating a base wallet takes every existing wallet on it offline, not just new
  // placements" finding.
  //
  // orderBy added for determinism: agentEndpoint has no DB-level uniqueness of its own (see the
  // schema comment on cloud_wallet_user_info), so more than one BASE_WALLET row can legitimately
  // share one (e.g. after an admin API key rotation re-registers the same endpoint under a second
  // row) -- without an explicit order, findFirst's choice isn't reproducible between calls.
  // Newest-registration-wins picks the freshest credentials deterministically. See the #71
  // review's "findFirst with no orderBy" finding.
  // eslint-disable-next-line camelcase
  async getBaseWalletByAgentEndpoint(agentEndpoint: string | null): Promise<cloud_wallet_user_info | null> {
    if (!agentEndpoint) {
      return null;
    }
    try {
      return await this.prisma.cloud_wallet_user_info.findFirst({
        where: {
          type: CloudWalletType.BASE_WALLET,
          agentEndpoint
        },
        orderBy: {
          createDateTime: 'desc'
        }
      });
    } catch (error) {
      this.logger.error(`Error in getBaseWalletByAgentEndpoint: ${error.message}`);
      throw error;
    }
  }

  // The actual atomic capacity claim createCloudWallet needs -- getAvailableBaseWallet's own read
  // (a separate, earlier findMany) only reflects capacity as of a moment ago, so two concurrent
  // requests can both read the same base wallet with room for exactly one more tenant and both
  // proceed to create a remote tenant against it, over-provisioning it past maxSubWallets. A plain
  // incrementBaseWalletUseCount call afterward (the previous approach) does not close that: it
  // always succeeds regardless of what useCount already is, so it records the over-provisioning
  // rather than preventing it.
  //
  // This is instead a single UPDATE with the capacity check IN the WHERE clause -- Postgres holds
  // the row lock for the statement's duration, so of two callers racing the same row, whichever
  // UPDATE actually commits first is the only one that can still see useCount below the cap; the
  // second re-evaluates the WHERE against the now-committed row and finds it no longer matches.
  // That makes "check capacity" and "claim it" one atomic operation instead of the two separate
  // round trips (a read, then an unconditional write) that left the race open.
  //
  // maxSubWallets is passed in from the caller's own earlier getAvailableBaseWallet() read rather
  // than re-read here: it's an admin-configured cap that changes far less often than useCount, and
  // using a Prisma column-to-column comparison in a WHERE filter isn't supported without raw SQL
  // (see getAvailableBaseWallet's own comment on the same limitation) -- a literal value from a
  // moment-old read is a reasonable, already-established tradeoff in this file, not a new one.
  //
  // Returns whether the claim actually landed (count === 1) so the caller can tell "I got the
  // slot" apart from "someone else already took it" and fail the request instead of proceeding
  // to create a tenant it has no claimed capacity for. See the #71 review.
  // eslint-disable-next-line camelcase
  async claimBaseWalletCapacity(walletId: string, maxSubWallets: number): Promise<boolean> {
    try {
      const result = await this.prisma.cloud_wallet_user_info.updateMany({
        where: { id: walletId, useCount: { lt: maxSubWallets } },
        data: { useCount: { increment: 1 } }
      });
      return 1 === result.count;
    } catch (error) {
      this.logger.error(`Error in claimBaseWalletCapacity: ${error.message}`);
      throw error;
    }
  }

  // Mirror of claimBaseWalletCapacity above, called from deleteCloudWallet (release on failure)
  // and createCloudWallet's own catch (release on a claimed-but-unused slot) -- without this,
  // useCount only ever goes up, so after maxSubWallets cumulative creations the base wallet
  // permanently reads "full" via getAvailableBaseWallet's useCount < maxSubWallets filter even if
  // every one of those sub-wallets has since been deleted. See the #73 review.
  async decrementBaseWalletUseCount(walletId: string): Promise<void> {
    try {
      // Guarded by useCount > 0, not a plain update -- a bare { decrement: 1 } has no floor, and
      // any base wallet configured before this migration already had real tenants at useCount = 0
      // (the column's default); deleting those drove useCount negative, which then made the
      // `useCount < maxSubWallets` capacity filter accept far more placements than the cap
      // allows -- the opposite of what it's for. This does not fix which row gets decremented
      // when more than one BASE_WALLET row shares an agentEndpoint (that needs the same
      // baseWalletId FK already tracked as a follow-up), only that this row's own counter can no
      // longer go below zero. See the #71 review.
      await this.prisma.cloud_wallet_user_info.updateMany({
        where: { id: walletId, useCount: { gt: 0 } },
        data: { useCount: { decrement: 1 } }
      });
    } catch (error) {
      this.logger.error(`Error in decrementBaseWalletUseCount: ${error.message}`);
      throw error;
    }
  }

  // Keyed on (userId, type), not email: the username-based signup flow (createUserByUsername)
  // never populates user.email at all, so a lookup keyed on email would throw
  // PrismaClientValidationError rather than a clean "not found" for those users. userId is always
  // populated regardless of which signup flow created the account, and every caller here already
  // has it (it's the JWT subject). type must be explicit too: every real caller of this method
  // wants "does this user have their own SUB_WALLET" specifically, not "any row of any type" --
  // without that, createCloudWallet's own duplicate-creation guard would incorrectly reject a
  // user who already has a BASE_WALLET admin row from ever creating their own SUB_WALLET.
  //
  // findFirst, not findUnique: (userId, type) is only DB-enforced-unique for SUB_WALLET rows (a
  // partial index, added by the subwallet-only-unique migration) -- a BASE_WALLET row has no such
  // guarantee, and findUnique requires its where clause to match a constraint Prisma Client
  // recognizes as unique. findFirst behaves identically for the SUB_WALLET case this method is
  // actually used for.
  // eslint-disable-next-line camelcase
  async checkUserExist(userId: string, type: CloudWalletType): Promise<cloud_wallet_user_info> {
    try {
      const agentDetails = await this.prisma.cloud_wallet_user_info.findFirst({
        where: {
          userId,
          type
        }
      });
      return agentDetails;
    } catch (error) {
      this.logger.error(`Error in getCloudWalletBaseAgentDetails: ${error.message}`);
      throw error;
    }
  }
  // eslint-disable-next-line camelcase
  async storeCloudWalletDetails(cloudWalletDetails: ICloudWalletDetails): Promise<IStoredWalletDetails> {
    try {
      const {
        label,
        lastChangedBy,
        tenantId,
        type,
        userId,
        agentApiKey,
        agentEndpoint,
        email,
        key,
        connectionImageUrl
      } = cloudWalletDetails;

      return await this.prisma.cloud_wallet_user_info.create({
        data: {
          label,
          tenantId,
          email,
          type,
          createdBy: userId,
          lastChangedBy,
          userId,
          agentEndpoint,
          agentApiKey,
          key,
          connectionImageUrl
        },
        select: {
          email: true,
          connectionImageUrl: true,
          createDateTime: true,
          id: true,
          tenantId: true,
          label: true,
          lastChangedDateTime: true
        }
      });
    } catch (error) {
      this.logger.error(`Error in storeCloudWalletDetails: ${error.message}`);
      throw error;
    }
  }

  async storeCloudWalletInfo(cloudWalletInfoPayload: IStoreWalletInfo): Promise<IGetStoredWalletInfo> {
    try {
      const { agentEndpoint, agentApiKey, email, type, userId, key, createdBy, lastChangedBy, maxSubWallets } =
        cloudWalletInfoPayload;
      const walletInfoData = await this.prisma.cloud_wallet_user_info.create({
        data: {
          type,
          agentApiKey,
          agentEndpoint,
          email,
          userId,
          key,
          createdBy,
          lastChangedBy,
          // undefined (not sent) is omitted by Prisma and falls through to the column's own
          // @default(5000) — see IStoreWalletInfo's comment.
          maxSubWallets
        },
        select: {
          id: true,
          email: true,
          type: true,
          userId: true,
          agentEndpoint: true
        }
      });
      return walletInfoData;
    } catch (error) {
      this.logger.error(`Error in storeCloudWalletInfo: ${error}`);
      throw error;
    }
  }

  // eslint-disable-next-line camelcase
  async getCloudSubWallet(userId: string): Promise<cloud_wallet_user_info | null> {
    try {
      // Filtered by type too — a user can now legitimately hold both a BASE_WALLET row and a
      // SUB_WALLET row (see the schema's @@unique([userId, type])), so userId alone is no longer
      // enough to unambiguously mean "this user's cloud sub-wallet".
      //
      // findFirst, not findFirstOrThrow: a holder with no cloud wallet (never created one, or
      // just deleted one) is a normal, expected case, not an exceptional one -- findFirstOrThrow
      // raised a raw PrismaClientKnownRequestError (P2025) that commonService.handleError does
      // not map (it only special-cases error.status.message.error, and PrismaClientKnownRequestError
      // has neither that shape nor a .response), so it reached the gateway as an opaque 500. That
      // also made every caller's own explicit `if (!cloudSubWalletDetails) throw NotFoundException`
      // guard unreachable for the exact case it exists to handle -- returning null here lets those
      // guards do their job. See the #73 review.
      const cloudSubWalletDetails = await this.prisma.cloud_wallet_user_info.findFirst({
        where: {
          userId,
          type: CloudWalletType.SUB_WALLET
        }
      });
      return cloudSubWalletDetails;
    } catch (error) {
      this.logger.error(`Error in getCloudSubWallet: ${error}`);
      throw error;
    }
  }

  // eslint-disable-next-line camelcase
  async getAllBaseWallets(): Promise<cloud_wallet_user_info[]> {
    try {
      return await this.prisma.cloud_wallet_user_info.findMany({
        where: {
          type: CloudWalletType.BASE_WALLET
        }
      });
    } catch (error) {
      this.logger.error(`Error in getAllBaseWallets: ${error}`);
      throw error;
    }
  }

  // Selects an active base wallet that still has capacity, deterministically (oldest-configured
  // first), for sub-wallet creation. Prisma has no built-in way to compare two columns of the
  // same row (useCount < maxSubWallets) in a WHERE filter without a raw query; the set of base
  // wallets is expected to be small (an operational/admin config, not per-tenant data), so
  // filtering the active rows in application code is simpler and safer here than raw SQL. See
  // the #71 review: the previous plain findFirstOrThrow (no capacity predicate, no ordering)
  // could reject creation with a full wallet A while an empty wallet B sat idle, and which of the
  // two was picked wasn't even reproducible between calls.
  // eslint-disable-next-line camelcase
  async getAvailableBaseWallet(): Promise<cloud_wallet_user_info | null> {
    try {
      const activeBaseWallets = await this.prisma.cloud_wallet_user_info.findMany({
        where: {
          type: CloudWalletType.BASE_WALLET,
          isActive: true
        },
        orderBy: { createDateTime: 'asc' }
      });
      return activeBaseWallets.find((wallet) => wallet.useCount < wallet.maxSubWallets) ?? null;
    } catch (error) {
      this.logger.error(`Error in getAvailableBaseWallet: ${error.message}`);
      throw error;
    }
  }

  async updateBaseWallet(
    walletId: string,
    isActive?: boolean,
    maxSubWallets?: number
    // eslint-disable-next-line camelcase
  ): Promise<cloud_wallet_user_info> {
    try {
      // Prisma's update() takes a WhereUniqueInput -- `type` isn't part of any unique constraint
      // on its own, so it can't be added directly to the update() call below. Verify the row is
      // actually a BASE_WALLET first: without this, `id` alone lets a caller target *any*
      // cloud_wallet_user_info row, including another user's CLOUD_SUB_WALLET.
      const existing = await this.prisma.cloud_wallet_user_info.findFirst({
        where: {
          id: walletId,
          type: CloudWalletType.BASE_WALLET
        }
      });
      if (!existing) {
        throw new NotFoundException(ResponseMessages.cloudWallet.error.notFoundBaseWallet);
      }

      // Built from only the keys actually supplied -- both isActive and maxSubWallets must be
      // independently omittable (see UpdateBaseWalletDto), so an unconditional `{isActive,
      // maxSubWallets}` here would silently write undefined -> Prisma column default (isActive:
      // true) whenever only the other field was sent. See the #71 review.
      // eslint-disable-next-line camelcase
      const data: Partial<Pick<cloud_wallet_user_info, 'isActive' | 'maxSubWallets'>> = {};
      if (undefined !== isActive) {
        data.isActive = isActive;
      }
      if (undefined !== maxSubWallets) {
        data.maxSubWallets = maxSubWallets;
      }

      return await this.prisma.cloud_wallet_user_info.update({
        where: {
          id: walletId
        },
        data
      });
    } catch (error) {
      this.logger.error(`Error in updateBaseWallet: ${error}`);
      throw error;
    }
  }

  // eslint-disable-next-line camelcase
  async deleteCloudWalletDetails(id: string): Promise<cloud_wallet_user_info> {
    try {
      return await this.prisma.cloud_wallet_user_info.delete({
        where: {
          id
        }
      });
    } catch (error) {
      this.logger.error(`Error in deleteCloudWalletDetails: ${error}`);
      throw error;
    }
  }

  async getUserInfo(email: string): Promise<user> {
    try {
      const userDetails = await this.prisma.user.findUnique({
        where: {
          email
        }
      });
      return userDetails;
    } catch (error) {
      this.logger.error(`Error in getUserInfo: ${error}`);
      throw error;
    }
  }
}
