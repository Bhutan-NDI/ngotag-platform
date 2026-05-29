import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { BaseService } from 'libs/service/base.service';
import { CommonConstants } from '@credebl/common/common.constant';
import {
  ResolveMarketplaceDto,
  LinkMarketplaceAccountDto,
  MarketplaceOrganizationDto,
  ActivateMarketplaceDto
} from './dto/marketplace.dto';

@Injectable()
export class MarketplaceService extends BaseService {
  constructor(@Inject('NATS_CLIENT') private readonly serviceProxy: ClientProxy) {
    super('MarketplaceGatewayService');
  }

  async resolveSubscription(payload: ResolveMarketplaceDto): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_RESOLVE_SUBSCRIPTION, payload);
  }

  async getOnboardingSession(sessionId: string, userId?: string): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_GET_ONBOARDING_SESSION, {
      sessionId,
      userId
    });
  }

  async linkAccount(
    sessionId: string,
    payload: LinkMarketplaceAccountDto,
    user: { id: string; email?: string; keycloakUserId?: string }
  ): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_LINK_ACCOUNT, {
      sessionId,
      payload,
      user
    });
  }

  async linkOrganization(
    sessionId: string,
    payload: MarketplaceOrganizationDto,
    user: { id: string; keycloakUserId?: string }
  ): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_LINK_ORGANIZATION, {
      sessionId,
      payload,
      user
    });
  }

  async activateSubscription(sessionId: string, payload: ActivateMarketplaceDto, userId: string): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_ACTIVATE_SUBSCRIPTION, {
      sessionId,
      orgId: payload.orgId,
      userId
    });
  }

  async getSubscription(subscriptionId: string, userId: string): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_GET_SUBSCRIPTION, {
      subscriptionId,
      userId
    });
  }

  async refreshSubscription(subscriptionId: string, userId: string): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_REFRESH_SUBSCRIPTION, {
      subscriptionId,
      userId
    });
  }

  async processWebhook(payload: unknown, authorization?: string): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_PROCESS_WEBHOOK, {
      payload,
      authorization
    });
  }

  async getEntitlements(orgId: string, userId: string): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_GET_ENTITLEMENTS, { orgId, userId });
  }

  async getUsageSummary(orgId: string, period: string | undefined, userId: string): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_GET_USAGE_SUMMARY, {
      orgId,
      period,
      userId
    });
  }

  async getMeteringEvents(orgId: string, userId: string): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_GET_METERING_EVENTS, { orgId, userId });
  }

  async recordUsageEvent(payload: {
    orgId: string;
    eventType: string;
    sourceTable?: string;
    sourceId: string;
    occurredAt?: string;
    quantity?: number;
    metadata?: Record<string, unknown>;
  }): Promise<object> {
    return this.sendNatsMessage(this.serviceProxy, CommonConstants.MARKETPLACE_RECORD_USAGE_EVENT, payload);
  }
}
