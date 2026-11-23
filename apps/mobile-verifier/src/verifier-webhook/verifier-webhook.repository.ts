import { Injectable } from '@nestjs/common';
import { Prisma, mobile_verifier_webhook_config as VerifierWebhookConfig } from '@prisma/client';
import { PrismaService } from '@credebl/prisma-service';

@Injectable()
export class VerifierWebhookRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async upsertWebhook(
    orgId: string,
    webhookId: string,
    data: Omit<Prisma.mobile_verifier_webhook_configUncheckedCreateInput, 'orgId' | 'webhookId'>
  ): Promise<VerifierWebhookConfig> {
    return this.prismaService.mobile_verifier_webhook_config.upsert({
      // eslint-disable-next-line camelcase -- Prisma compound-unique key name
      where: { orgId_webhookId: { orgId, webhookId } },
      create: { orgId, webhookId, ...data },
      update: { ...data }
    });
  }

  // Scoped by orgId so a webhook config can never be looked up across organizations.
  async getWebhook(orgId: string, webhookId?: string): Promise<VerifierWebhookConfig | null> {
    if (webhookId) {
      return this.prismaService.mobile_verifier_webhook_config.findFirst({ where: { orgId, webhookId } });
    }
    return this.prismaService.mobile_verifier_webhook_config.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'desc' }
    });
  }
}
