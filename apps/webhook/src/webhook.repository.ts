/* eslint-disable camelcase */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@credebl/prisma-service';
import { ICreateWebhookUrl, IGetWebhookUrl } from '../interfaces/webhook.interfaces';
import { org_agents } from '@prisma/client';
import { IWebhookUrl } from '@credebl/common/interfaces/webhook.interface';
import { encryptClientCredential } from '@credebl/common/cast.helper';
import { CloudWalletType } from '@credebl/enum/enum';
@Injectable()
export class WebhookRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger
  ) {}

  async registerWebhook(orgId: string, webhookUrl: string, webhookSecret?: string): Promise<ICreateWebhookUrl> {
    try {
      const agentInfo = this.prisma.org_agents.update({
        where: {
          orgId
        },
        data: {
          webhookUrl,
          webhookSecret: webhookSecret ? await encryptClientCredential(webhookSecret) : undefined
        }
      });

      return agentInfo;
    } catch (error) {
      this.logger.error(`[registerWebhookUrl] - register webhook url details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async updateWebhook(orgId: string, webhookUrl?: string, webhookSecret?: string): Promise<ICreateWebhookUrl> {
    try {
      const data: { webhookUrl?: string; webhookSecret?: string | null } = {};
      if (undefined !== webhookUrl) {
        data.webhookUrl = webhookUrl;
      }
      if (undefined !== webhookSecret) {
        data.webhookSecret = webhookSecret ? await encryptClientCredential(webhookSecret) : null;
      }

      const agentInfo = await this.prisma.org_agents.update({
        where: {
          orgId
        },
        data
      });

      return agentInfo;
    } catch (error) {
      this.logger.error(`[updateWebhook] - update webhook details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async getWebhookUrl(getWebhook: IWebhookUrl): Promise<IGetWebhookUrl> {
    try {
      const { tenantId, orgId } = getWebhook;
      let webhookUrlInfo;

      if ((undefined === tenantId || 'default' === tenantId) && orgId) {
        webhookUrlInfo = await this.prisma.org_agents.findFirstOrThrow({
          where: {
            orgId
          }
        });
      } else if (tenantId && 'default' !== tenantId && orgId) {
        // Tenant first: shared-agent tenants arrive on the base wallet's orgId path, so orgId alone resolves the wrong org.
        webhookUrlInfo = await this.prisma.org_agents.findFirst({
          where: {
            tenantId
          }
        });

        if (!webhookUrlInfo) {
          // orgId fallback only for cloud-wallet holders; an unknown shared tenant would otherwise resolve to the platform-admin org.
          const cloudWalletHolder = await this.prisma.cloud_wallet_user_info.findFirst({
            where: {
              tenantId,
              type: CloudWalletType.SUB_WALLET
            },
            select: {
              id: true
            }
          });

          if (!cloudWalletHolder) {
            throw new NotFoundException(`No org agent or cloud wallet found for tenantId ${tenantId}`);
          }

          webhookUrlInfo = await this.prisma.org_agents.findFirstOrThrow({
            where: {
              orgId
            }
          });
        }
      }

      // TEMP DIAGNOSTIC: confirm the lookup resolves the requested org; remove after QA verification
      this.logger.error(
        `[getWebhookUrl] queried tenantId=${tenantId} orgId=${orgId} -> resolved orgId=${webhookUrlInfo?.orgId} tenantId=${webhookUrlInfo?.tenantId} webhookUrl=${webhookUrlInfo?.webhookUrl}`
      );

      return webhookUrlInfo;
    } catch (error) {
      this.logger.error(`[getWebhookUrl] -  webhook url details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async getOrganizationDetails(orgId: string): Promise<org_agents> {
    try {
      return this.prisma.org_agents.findUnique({
        where: {
          orgId
        }
      });
    } catch (error) {
      this.logger.error(`error: ${JSON.stringify(error)}`);
      throw error;
    }
  }
}
