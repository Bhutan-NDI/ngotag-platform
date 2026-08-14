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

  // eslint-disable-next-line camelcase
  async getCloudWalletDetails(type: CloudWalletType): Promise<cloud_wallet_user_info> {
    try {
      const agentDetails = await this.prisma.cloud_wallet_user_info.findFirstOrThrow({
        where: {
          type
        }
      });
      return agentDetails;
    } catch (error) {
      this.logger.error(`Error in getCloudWalletBaseAgentDetails: ${error.message}`);
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
  // user who already has a BASE_WALLET admin row (see the (userId, type) compound below) from
  // ever creating their own SUB_WALLET. Uses the (userId, type) compound unique directly.
  // eslint-disable-next-line camelcase
  async checkUserExist(userId: string, type: CloudWalletType): Promise<cloud_wallet_user_info> {
    try {
      const agentDetails = await this.prisma.cloud_wallet_user_info.findUnique({
        where: {
          // eslint-disable-next-line camelcase
          userId_type: {
            userId,
            type
          }
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

  // Keyed on (email, type), not email alone: email is no longer globally unique on this model
  // (see the compound-unique schema comment) -- the same person's email legitimately appears on
  // both their BASE_WALLET row and their own SUB_WALLET row, so a bare email lookup could now
  // return either one. This method is only ever used by configureBaseWallet's duplicate-creation
  // guard, so type is always BASE_WALLET there.
  // eslint-disable-next-line camelcase
  async getCloudWalletInfo(email: string, type: CloudWalletType): Promise<cloud_wallet_user_info> {
    try {
      const walletInfoData = await this.prisma.cloud_wallet_user_info.findUnique({
        where: {
          // eslint-disable-next-line camelcase
          email_type: {
            email,
            type
          }
        }
      });
      return walletInfoData;
    } catch (error) {
      this.logger.error(`Error in getCloudWalletInfo: ${error}`);
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
  async getCloudSubWallet(userId: string): Promise<cloud_wallet_user_info> {
    try {
      // Filtered by type too — a user can now legitimately hold both a BASE_WALLET row and a
      // SUB_WALLET row (see the schema's @@unique([userId, type])), so userId alone is no longer
      // enough to unambiguously mean "this user's cloud sub-wallet".
      const cloudSubWalletDetails = await this.prisma.cloud_wallet_user_info.findFirstOrThrow({
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

  // eslint-disable-next-line camelcase
  async updateBaseWallet(walletId: string, isActive: boolean, maxSubWallets: number): Promise<cloud_wallet_user_info> {
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

      return await this.prisma.cloud_wallet_user_info.update({
        where: {
          id: walletId
        },
        data: {
          isActive,
          maxSubWallets
        }
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
