import { Injectable } from '@nestjs/common';
import {
  MarketplaceActivationStatus,
  MarketplaceOnboardingStatus,
  MarketplaceSubscriptionStatus,
  MarketplaceUsageStatus,
  Prisma
} from '@prisma/client';
import { PrismaService } from '@credebl/prisma-service';
import { MarketplaceResolvedSubscription, MarketplaceUsageEventPayload } from '../interfaces/marketplace.interface';

@Injectable()
export class MarketplaceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertResolvedSubscription(
    resolved: MarketplaceResolvedSubscription
  ): Promise<Prisma.marketplace_subscriptionGetPayload<{}>> {
    const data = this.toSubscriptionData(resolved);

    return this.prisma.marketplace_subscription.upsert({
      where: { marketplaceSubscriptionId: resolved.id },
      create: data,
      update: {
        ...data,
        lastResolvedAt: new Date(),
        lastSyncedAt: new Date(),
        lastChangedDateTime: new Date()
      }
    });
  }

  async updateSubscriptionFromMicrosoft(
    resolved: MarketplaceResolvedSubscription
  ): Promise<Prisma.marketplace_subscriptionGetPayload<{}>> {
    const data = this.toSubscriptionData(resolved);
    return this.prisma.marketplace_subscription.update({
      where: { marketplaceSubscriptionId: resolved.id },
      data: {
        ...data,
        lastSyncedAt: new Date(),
        lastChangedDateTime: new Date()
      }
    });
  }

  async getSubscriptionByMarketplaceId(
    marketplaceSubscriptionId: string
  ): Promise<Prisma.marketplace_subscriptionGetPayload<{}> | null> {
    return this.prisma.marketplace_subscription.findUnique({ where: { marketplaceSubscriptionId } });
  }

  async getSubscriptionByInternalId(id: string): Promise<Prisma.marketplace_subscriptionGetPayload<{}> | null> {
    return this.prisma.marketplace_subscription.findUnique({ where: { id } });
  }

  async getSubscriptionByOrgId(orgId: string): Promise<Prisma.marketplace_subscriptionGetPayload<{}> | null> {
    return this.prisma.marketplace_subscription.findFirst({
      where: { orgId, deletedAt: null },
      orderBy: { createDateTime: 'desc' }
    });
  }

  async listActiveSubscriptions(): Promise<Prisma.marketplace_subscriptionGetPayload<{}>[]> {
    return this.prisma.marketplace_subscription.findMany({
      where: { deletedAt: null, saasSubscriptionStatus: 'Subscribed' }
    });
  }

  async createOnboardingSession(
    subscriptionId: string,
    marketplaceTokenHash: string,
    buyer: { tenantId?: string; objectId?: string; email?: string },
    metadata: unknown
  ): Promise<Prisma.marketplace_onboarding_sessionGetPayload<{}>> {
    const activeSession = await this.prisma.marketplace_onboarding_session.findFirst({
      where: {
        marketplaceSubscriptionId: subscriptionId,
        expiresAt: { gt: new Date() },
        status: { notIn: ['activated', 'expired', 'failed'] }
      },
      orderBy: { createDateTime: 'desc' }
    });

    if (activeSession) {
      return activeSession;
    }

    return this.prisma.marketplace_onboarding_session.create({
      data: {
        marketplaceSubscriptionId: subscriptionId,
        marketplaceTokenHash,
        buyerTenantId: buyer.tenantId,
        buyerObjectId: buyer.objectId,
        buyerEmail: buyer.email,
        status: 'resolved',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        metadata: this.toJson(metadata)
      }
    });
  }

  async getOnboardingSession(
    sessionId: string
  ): Promise<Prisma.marketplace_onboarding_sessionGetPayload<{ include: { subscription: true } }> | null> {
    return this.prisma.marketplace_onboarding_session.findUnique({
      where: { id: sessionId },
      include: { subscription: true }
    });
  }

  async updateOnboardingSession(
    sessionId: string,
    status: MarketplaceOnboardingStatus,
    metadata?: unknown
  ): Promise<void> {
    await this.prisma.marketplace_onboarding_session.update({
      where: { id: sessionId },
      data: {
        status,
        metadata: metadata === undefined ? undefined : this.toJson(metadata),
        lastChangedDateTime: new Date()
      }
    });
  }

  async linkUser(subscriptionId: string, userId: string): Promise<void> {
    await this.prisma.marketplace_subscription.update({
      where: { id: subscriptionId },
      data: { localUserId: userId, lastChangedDateTime: new Date() }
    });
  }

  async linkOrganization(subscriptionId: string, orgId: string): Promise<void> {
    await this.prisma.marketplace_subscription.update({
      where: { id: subscriptionId },
      data: { orgId, lastChangedDateTime: new Date() }
    });
  }

  async setActivationStatus(
    subscriptionId: string,
    activationStatus: MarketplaceActivationStatus,
    activationError?: string
  ): Promise<void> {
    await this.prisma.marketplace_subscription.update({
      where: { id: subscriptionId },
      data: { activationStatus, activationError, lastChangedDateTime: new Date() }
    });
  }

  async setSubscriptionStatus(id: string, status: MarketplaceSubscriptionStatus): Promise<void> {
    await this.prisma.marketplace_subscription.update({
      where: { id },
      data: { saasSubscriptionStatus: status, lastChangedDateTime: new Date() }
    });
  }

  async getPlan(offerId: string, planId: string): Promise<Prisma.marketplace_planGetPayload<{}> | null> {
    return this.prisma.marketplace_plan.findUnique({ where: { offerId_planId: { offerId, planId } } });
  }

  async getUsageTotals(orgId: string, start: Date, end: Date): Promise<{ eventType: string; quantity: number }[]> {
    const events = await this.prisma.billing_usage_event.groupBy({
      by: ['eventType'],
      where: {
        orgId,
        occurredAt: { gte: start, lte: end }
      },
      _sum: { quantity: true }
    });

    return events.map((event) => ({ eventType: event.eventType, quantity: Number(event._sum.quantity || 0) }));
  }

  async listMeteringEvents(orgId: string): Promise<Prisma.marketplace_usage_eventGetPayload<{}>[]> {
    return this.prisma.marketplace_usage_event.findMany({
      where: { orgId },
      orderBy: { usageStartTime: 'desc' },
      take: 50
    });
  }

  async recordBillingUsageEvent(
    payload: MarketplaceUsageEventPayload,
    marketplaceSubscriptionId?: string
  ): Promise<void> {
    const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();

    await this.prisma.billing_usage_event.upsert({
      where: { eventType_sourceId: { eventType: payload.eventType, sourceId: payload.sourceId } },
      create: {
        orgId: payload.orgId,
        marketplaceSubscriptionId,
        eventType: payload.eventType,
        sourceTable: payload.sourceTable,
        sourceId: payload.sourceId,
        occurredAt,
        billingPeriod: this.getBillingPeriod(occurredAt),
        quantity: payload.quantity || 1,
        metadata: this.toJson(payload.metadata)
      },
      update: {}
    });
  }

  async createOrUpdateUsageEvent(payload: {
    subscriptionId: string;
    orgId: string;
    dimension: string;
    quantity: number;
    usageStartTime: Date;
    sourceEventIds: string[];
  }): Promise<Prisma.marketplace_usage_eventGetPayload<{}>> {
    return this.prisma.marketplace_usage_event.upsert({
      where: {
        marketplaceSubscriptionId_dimension_usageStartTime: {
          marketplaceSubscriptionId: payload.subscriptionId,
          dimension: payload.dimension,
          usageStartTime: payload.usageStartTime
        }
      },
      create: {
        marketplaceSubscriptionId: payload.subscriptionId,
        orgId: payload.orgId,
        dimension: payload.dimension,
        quantity: payload.quantity,
        usageStartTime: payload.usageStartTime,
        status: 'pending',
        sourceEventIds: payload.sourceEventIds
      },
      update: {
        quantity: payload.quantity,
        sourceEventIds: payload.sourceEventIds,
        lastChangedDateTime: new Date()
      }
    });
  }

  async listPendingUsageEvents(): Promise<
    Prisma.marketplace_usage_eventGetPayload<{ include: { subscription: true } }>[]
  > {
    return this.prisma.marketplace_usage_event.findMany({
      where: { status: { in: ['pending', 'failed'] } },
      include: { subscription: true },
      orderBy: { usageStartTime: 'asc' },
      take: 25
    });
  }

  async updateUsageEventStatus(
    id: string,
    status: MarketplaceUsageStatus,
    response: { status?: string; message?: string; requestId?: string; correlationId?: string }
  ): Promise<void> {
    await this.prisma.marketplace_usage_event.update({
      where: { id },
      data: {
        status,
        marketplaceResponseStatus: response.status,
        marketplaceMessage: response.message,
        requestId: response.requestId,
        correlationId: response.correlationId,
        submittedAt: new Date(),
        lastChangedDateTime: new Date()
      }
    });
  }

  async createWebhookEvent(payload: {
    operationId?: string;
    activityId?: string;
    subscriptionId: string;
    marketplaceSubscriptionId?: string;
    action: string;
    status?: string;
    body: Prisma.InputJsonValue;
    headers?: Prisma.InputJsonValue;
    validationStatus?: string;
  }): Promise<Prisma.marketplace_webhook_eventGetPayload<{}>> {
    return this.prisma.marketplace_webhook_event.create({
      data: {
        operationId: payload.operationId,
        activityId: payload.activityId,
        subscriptionId: payload.subscriptionId,
        marketplaceSubscriptionId: payload.marketplaceSubscriptionId,
        action: payload.action,
        status: payload.status,
        payload: payload.body,
        headers: payload.headers,
        validationStatus: payload.validationStatus,
        processingStatus: 'received'
      }
    });
  }

  async updateWebhookEvent(
    id: string,
    processingStatus: 'validated' | 'processed' | 'failed',
    error?: string
  ): Promise<void> {
    await this.prisma.marketplace_webhook_event.update({
      where: { id },
      data: { processingStatus, error, lastChangedDateTime: new Date() }
    });
  }

  async upsertOperation(payload: {
    operationId: string;
    subscriptionId: string;
    action: string;
    status?: string;
    planId?: string;
    quantity?: number;
    rawPayload?: Prisma.InputJsonValue;
    ackStatus: 'not_required' | 'pending' | 'success' | 'failure';
    ackError?: string;
  }): Promise<void> {
    await this.prisma.marketplace_operation.upsert({
      where: {
        operationId_marketplaceSubscriptionId: {
          operationId: payload.operationId,
          marketplaceSubscriptionId: payload.subscriptionId
        }
      },
      create: {
        operationId: payload.operationId,
        marketplaceSubscriptionId: payload.subscriptionId,
        action: payload.action,
        status: payload.status,
        planId: payload.planId,
        quantity: payload.quantity,
        rawPayload: payload.rawPayload,
        ackStatus: payload.ackStatus,
        ackError: payload.ackError
      },
      update: {
        status: payload.status,
        planId: payload.planId,
        quantity: payload.quantity,
        rawPayload: payload.rawPayload,
        ackStatus: payload.ackStatus,
        ackError: payload.ackError,
        lastChangedDateTime: new Date()
      }
    });
  }

  async getBillableEventsForSubscription(
    subscriptionId: string,
    start: Date,
    end: Date
  ): Promise<Prisma.billing_usage_eventGetPayload<{}>[]> {
    return this.prisma.billing_usage_event.findMany({
      where: {
        marketplaceSubscriptionId: subscriptionId,
        occurredAt: { gte: start, lte: end }
      },
      orderBy: { occurredAt: 'asc' }
    });
  }

  async updateOperationAckStatus(
    operationId: string,
    subscriptionId: string,
    ackStatus: 'success' | 'failure',
    ackError?: string
  ): Promise<void> {
    await this.prisma.marketplace_operation.update({
      where: {
        operationId_marketplaceSubscriptionId: {
          operationId,
          marketplaceSubscriptionId: subscriptionId
        }
      },
      data: { ackStatus, ackError, lastChangedDateTime: new Date() }
    });
  }

  private toSubscriptionData(resolved: MarketplaceResolvedSubscription): Prisma.marketplace_subscriptionCreateInput {
    return {
      marketplaceSubscriptionId: resolved.id,
      publisherId: resolved.publisherId,
      offerId: resolved.offerId,
      planId: resolved.planId,
      subscriptionName: resolved.name,
      saasSubscriptionStatus: resolved.saasSubscriptionStatus,
      quantity: resolved.quantity,
      termUnit: resolved.term?.termUnit,
      termStartDate: resolved.term?.startDate ? new Date(resolved.term.startDate) : undefined,
      termEndDate: resolved.term?.endDate ? new Date(resolved.term.endDate) : undefined,
      autoRenew: resolved.autoRenew,
      isFreeTrial: resolved.isFreeTrial,
      isTest: resolved.isTest,
      sandboxType: resolved.sandboxType,
      allowedCustomerOperations: resolved.allowedCustomerOperations || [],
      purchaserEmail: resolved.purchaser?.emailId,
      purchaserTenantId: resolved.purchaser?.tenantId,
      purchaserObjectId: resolved.purchaser?.objectId,
      purchaserPuid: resolved.purchaser?.puid,
      beneficiaryEmail: resolved.beneficiary?.emailId,
      beneficiaryTenantId: resolved.beneficiary?.tenantId,
      beneficiaryObjectId: resolved.beneficiary?.objectId,
      beneficiaryPuid: resolved.beneficiary?.puid,
      lastResolvedAt: new Date(),
      lastSyncedAt: new Date(),
      metadata: this.toJson(resolved)
    };
  }

  private getBillingPeriod(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }
}
