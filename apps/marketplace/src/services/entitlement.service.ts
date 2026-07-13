import { Injectable } from '@nestjs/common';
import { marketplace_plan, marketplace_subscription } from '@prisma/client';
import { MarketplaceEntitlementResponse } from '../interfaces/marketplace.interface';
import { MarketplaceRepository } from '../repositories/marketplace.repository';

const defaultFeatures: Record<string, boolean> = {
  schemaCreate: true,
  credentialDefinitionCreate: true,
  issuance: true,
  bulkIssuance: true,
  verification: true,
  apiAccess: true
};

const eventTypeByDimension: Record<string, string> = {
  setup_fee: 'organization_setup_completed',
  issuance_txn: 'issuance_completed',
  verification_txn: 'verification_completed',
  schema_create: 'schema_created'
};

@Injectable()
export class EntitlementService {
  constructor(private readonly marketplaceRepository: MarketplaceRepository) {}

  async getEntitlements(orgId: string): Promise<MarketplaceEntitlementResponse> {
    // First-party / foundational orgs are core national infrastructure, not Marketplace tenants.
    // Grant them the full feature set (equivalent to PLATFORM_ADMIN_ENTITLEMENTS) regardless of
    // subscription state, scoped only to the allow-listed org ids.
    if (this.isExemptOrg(orgId)) {
      return {
        orgId,
        features: defaultFeatures,
        limits: {},
        usage: {},
        blockedReason: null
      };
    }

    const subscription = await this.marketplaceRepository.getSubscriptionByOrgId(orgId);

    if (!subscription) {
      const marketplaceRequired = `${process.env.MARKETPLACE_REQUIRED}`.toLowerCase() === 'true';
      return {
        orgId,
        features: marketplaceRequired ? this.disableFeatures() : defaultFeatures,
        limits: {},
        usage: {},
        blockedReason: marketplaceRequired ? 'marketplace_subscription_required' : null
      };
    }

    const plan = await this.getPlan(subscription);
    const usage = await this.getUsage(subscription, plan);
    const isActive =
      subscription.saasSubscriptionStatus === 'Subscribed' && subscription.activationStatus === 'activated';
    const features = isActive ? this.planFeatures(plan) : this.disableFeatures();

    return {
      orgId,
      subscription: {
        subscriptionId: subscription.marketplaceSubscriptionId,
        status: subscription.saasSubscriptionStatus,
        planId: subscription.planId
      },
      features,
      limits: {
        maxUsers: plan?.maxUsers || null,
        maxOrganizations: plan?.maxOrganizations || null
      },
      usage,
      blockedReason: isActive ? null : this.blockedReason(subscription)
    };
  }

  private isExemptOrg(orgId: string): boolean {
    if (!orgId) {
      return false;
    }
    const exempt = `${process.env.MARKETPLACE_EXEMPT_ORG_IDS || ''}`
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean);
    return exempt.includes(orgId.trim().toLowerCase());
  }

  async isFeatureAllowed(orgId: string, feature: string): Promise<boolean> {
    const entitlements = await this.getEntitlements(orgId);
    return Boolean(entitlements.features[feature]);
  }

  private async getPlan(subscription: marketplace_subscription): Promise<marketplace_plan | null> {
    return this.marketplaceRepository.getPlan(subscription.offerId, subscription.planId);
  }

  private planFeatures(plan: marketplace_plan | null): Record<string, boolean> {
    if (!plan?.features) {
      return defaultFeatures;
    }

    const features = typeof plan.features === 'object' && !Array.isArray(plan.features) ? plan.features : {};
    return { ...defaultFeatures, ...(features as Record<string, boolean>) };
  }

  private disableFeatures(): Record<string, boolean> {
    return Object.keys(defaultFeatures).reduce((features, feature) => ({ ...features, [feature]: false }), {});
  }

  private blockedReason(subscription: marketplace_subscription): string | null {
    if (subscription.saasSubscriptionStatus === 'PendingFulfillmentStart') {
      return 'marketplace_activation_required';
    }
    if (subscription.saasSubscriptionStatus === 'Suspended') {
      return 'marketplace_subscription_suspended';
    }
    if (subscription.saasSubscriptionStatus === 'Unsubscribed') {
      return 'marketplace_subscription_unsubscribed';
    }
    if (subscription.activationStatus === 'failed') {
      return 'marketplace_activation_failed';
    }
    return null;
  }

  private async getUsage(
    subscription: marketplace_subscription,
    plan: marketplace_plan | null
  ): Promise<Record<string, { included: number; used: number; overage: number }>> {
    const start =
      subscription.termStartDate || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const end = subscription.termEndDate || new Date();
    const totals = subscription.orgId
      ? await this.marketplaceRepository.getUsageTotals(subscription.orgId, start, end)
      : [];
    const usage: Record<string, { included: number; used: number; overage: number }> = {};

    for (const [dimension, eventType] of Object.entries(eventTypeByDimension)) {
      const used = totals.find((total) => total.eventType === eventType)?.quantity || 0;
      const included = this.includedForDimension(plan, dimension);
      usage[dimension] = {
        included,
        used,
        overage: Math.max(used - included, 0)
      };
    }

    return usage;
  }

  private includedForDimension(plan: marketplace_plan | null, dimension: string): number {
    if (!plan) {
      return 0;
    }

    const includedByDimension: Record<string, number> = {
      setup_fee: 0,
      issuance_txn: plan.includedIssuanceTransactions,
      verification_txn: plan.includedVerificationTransactions,
      schema_create: plan.includedSchemas
    };

    return includedByDimension[dimension] || 0;
  }
}
