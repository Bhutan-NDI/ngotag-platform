import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { CommonConstants } from '@credebl/common/common.constant';
import {
  MarketplaceUsageEventPayload,
  MarketplaceWebhookPayload,
  ResolveMarketplacePayload
} from './interfaces/marketplace.interface';
import { MarketplaceService } from './marketplace.service';

@Controller()
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_RESOLVE_SUBSCRIPTION })
  async resolveSubscription(payload: ResolveMarketplacePayload): Promise<object> {
    return this.marketplaceService.resolveSubscription(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_GET_ONBOARDING_SESSION })
  async getOnboardingSession(payload: { sessionId: string; userId?: string }): Promise<object> {
    return this.marketplaceService.getOnboardingSession(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_LINK_ACCOUNT })
  async linkAccount(payload): Promise<object> {
    return this.marketplaceService.linkAccount(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_LINK_ORGANIZATION })
  async linkOrganization(payload): Promise<object> {
    return this.marketplaceService.linkOrganization(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_ACTIVATE_SUBSCRIPTION })
  async activateSubscription(payload: { sessionId: string; orgId: string; userId: string }): Promise<object> {
    return this.marketplaceService.activateSubscription(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_GET_SUBSCRIPTION })
  async getSubscription(payload: { subscriptionId: string; userId: string }): Promise<object> {
    return this.marketplaceService.getSubscription(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_REFRESH_SUBSCRIPTION })
  async refreshSubscription(payload: { subscriptionId: string; userId: string }): Promise<object> {
    return this.marketplaceService.refreshSubscription(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_PROCESS_WEBHOOK })
  async processWebhook(payload: { payload: MarketplaceWebhookPayload; authorization?: string }): Promise<object> {
    return this.marketplaceService.processWebhook(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_GET_ENTITLEMENTS })
  async getEntitlements(payload: { orgId: string; userId: string }): Promise<object> {
    return this.marketplaceService.getEntitlements(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_GET_USAGE_SUMMARY })
  async getUsageSummary(payload: { orgId: string; period?: string; userId: string }): Promise<object> {
    return this.marketplaceService.getUsageSummary(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_GET_METERING_EVENTS })
  async getMeteringEvents(payload: { orgId: string; userId: string }): Promise<object> {
    return this.marketplaceService.getMeteringEvents(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_RECORD_USAGE_EVENT })
  async recordUsageEvent(payload: MarketplaceUsageEventPayload): Promise<object> {
    return this.marketplaceService.recordUsageEvent(payload);
  }

  @MessagePattern({ cmd: CommonConstants.MARKETPLACE_SUBMIT_METERING })
  async submitMetering(): Promise<object> {
    return this.marketplaceService.submitMetering();
  }
}
