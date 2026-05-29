import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MarketplaceRepository } from '../repositories/marketplace.repository';
import { MicrosoftMarketplaceClient } from './microsoft-marketplace.client';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger('ReconciliationService');

  constructor(
    private readonly marketplaceRepository: MarketplaceRepository,
    private readonly microsoftMarketplaceClient: MicrosoftMarketplaceClient
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async reconcileSubscriptions(): Promise<void> {
    if (`${process.env.MARKETPLACE_RECONCILIATION_ENABLED}`.toLowerCase() !== 'true') {
      return;
    }

    const subscriptions = await this.microsoftMarketplaceClient.listSubscriptions();

    for (const subscription of subscriptions) {
      const existing = await this.marketplaceRepository.getSubscriptionByMarketplaceId(subscription.id);
      if (existing) {
        await this.marketplaceRepository.updateSubscriptionFromMicrosoft(subscription);
      } else {
        await this.marketplaceRepository.upsertResolvedSubscription(subscription);
      }
    }

    this.logger.log(`Reconciled ${subscriptions.length} Marketplace subscriptions`);
  }
}
