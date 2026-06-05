import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { ClientProxy, NatsRecordBuilder } from '@nestjs/microservices';
import { createHash } from 'crypto';
import { BaseService } from 'libs/service/base.service';
import * as nats from 'nats';
import { firstValueFrom } from 'rxjs';
import { v4 } from 'uuid';
import {
  MarketplaceBuyerClaims,
  MarketplaceNextAction,
  MarketplaceResolvedSubscription,
  MarketplaceSubscriptionStatus,
  MarketplaceUsageEventPayload,
  MarketplaceWebhookPayload,
  ResolveMarketplacePayload
} from './interfaces/marketplace.interface';
import { MarketplaceRepository } from './repositories/marketplace.repository';
import { EntitlementService } from './services/entitlement.service';
import { MeteringService } from './services/metering.service';
import { MicrosoftMarketplaceClient } from './services/microsoft-marketplace.client';
import { WebhookService } from './services/webhook.service';

const SETUP_FEE_USD = 30000;

interface LinkAccountMessage {
  sessionId: string;
  payload: {
    mode: 'existing_user' | 'create_from_microsoft_sso';
    email?: string;
    firstName?: string;
    lastName?: string;
    microsoftTenantId?: string;
    microsoftObjectId?: string;
  };
  user: { id: string; email?: string; keycloakUserId?: string };
}

interface LinkOrganizationMessage {
  sessionId: string;
  payload: {
    mode: 'create' | 'link_existing';
    orgId?: string;
    organization?: {
      name: string;
      description?: string;
      website?: string;
      logo?: string;
    };
  };
  user: { id: string; keycloakUserId?: string };
}

@Injectable()
export class MarketplaceService extends BaseService {
  constructor(
    @Inject('ORGANIZATION_CLIENT') private readonly organizationClient: ClientProxy,
    private readonly marketplaceRepository: MarketplaceRepository,
    private readonly microsoftMarketplaceClient: MicrosoftMarketplaceClient,
    private readonly entitlementService: EntitlementService,
    private readonly meteringService: MeteringService,
    private readonly webhookService: WebhookService
  ) {
    super('MarketplaceService');
  }

  private sendNatsMessage<T = any>(
    serviceProxy: Pick<ClientProxy, 'send'>,
    cmd: string,
    payload: unknown
  ): Promise<T> {
    const headers = nats.headers();
    headers.set('contextId', v4());
    const record = new NatsRecordBuilder(payload).setHeaders(headers).build();

    return firstValueFrom(serviceProxy.send<T>({ cmd }, record));
  }

  async resolveSubscription(payload: ResolveMarketplacePayload): Promise<object> {
    const marketplaceToken = this.decodeMarketplaceToken(payload.marketplaceToken);
    const resolved = await this.resolveWithMicrosoftOrMock(marketplaceToken);
    const subscription = await this.marketplaceRepository.upsertResolvedSubscription(resolved);
    const buyer = this.buyerFromClaims(payload.buyerClaims, resolved);
    const onboardingSession = await this.marketplaceRepository.createOnboardingSession(
      subscription.id,
      this.hashToken(marketplaceToken),
      buyer,
      { buyerClaims: payload.buyerClaims || null }
    );

    return {
      onboardingSessionId: onboardingSession.id,
      ...this.toSubscriptionSummary(subscription),
      nextAction: this.nextAction(subscription)
    };
  }

  async getOnboardingSession(message: { sessionId: string }): Promise<object> {
    const session = await this.getValidSession(message.sessionId);
    return {
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      nextAction: this.nextAction(session.subscription),
      linkedOrgId: session.subscription.orgId,
      subscription: this.toSubscriptionSummary(session.subscription)
    };
  }

  async linkAccount(message: LinkAccountMessage): Promise<object> {
    const session = await this.getValidSession(message.sessionId);

    // Identity bind-check: a valid onboarding sessionId must only be linked by the user
    // who actually purchased/benefits from the subscription, otherwise any authenticated
    // user holding a sessionId could hijack someone else's Marketplace subscription.
    // Compare ONLY the signed-in JWT email (message.user.email) — payload.email is
    // caller-supplied and must not influence the decision. Fail hard on mismatch.
    // (Delegated operators with a different email are intentionally NOT supported here;
    // that would require an explicit authorization/invite mechanism.)
    const userEmail = (message.user.email || '').toLowerCase();
    const expectedEmails = [
      (session.subscription.purchaserEmail || '').toLowerCase(),
      (session.subscription.beneficiaryEmail || '').toLowerCase()
    ].filter(Boolean);

    // Fail closed: if there is no purchaser/beneficiary identity to bind to, or the
    // signed-in user has no email, we cannot authorize the link. Absent purchaser emails
    // indicate a bad resolution, not a reason to allow an unverified link.
    if (!expectedEmails.length || !userEmail) {
      this.logger.warn(
        `Marketplace account link blocked on session ${session.id}: missing purchaser/beneficiary or signed-in email to verify against`
      );
      throw new ForbiddenException({
        code: 'marketplace_account_identity_unverified',
        message: 'Unable to verify your account against the Microsoft Marketplace purchaser.'
      });
    }

    if (!expectedEmails.includes(userEmail)) {
      // Do not log the email address itself (PII); the session id is enough to investigate.
      this.logger.warn(
        `Marketplace account link blocked on session ${session.id}: signed-in user does not match the purchaser/beneficiary`
      );
      throw new ForbiddenException({
        code: 'marketplace_account_email_mismatch',
        message:
          'Your account email does not match the Microsoft Marketplace purchaser. Sign in with the account that purchased the subscription.'
      });
    }

    await this.marketplaceRepository.linkUser(session.subscription.id, message.user.id);
    await this.marketplaceRepository.updateOnboardingSession(session.id, 'account_linked', {
      mode: message.payload.mode,
      email: message.payload.email || message.user.email || null,
      microsoftTenantId: message.payload.microsoftTenantId || null,
      microsoftObjectId: message.payload.microsoftObjectId || null
    });

    return { linkedUserId: message.user.id, nextAction: 'create_organization' };
  }

  async linkOrganization(message: LinkOrganizationMessage): Promise<object> {
    const session = await this.getValidSession(message.sessionId);

    if (message.payload.mode === 'link_existing') {
      if (!message.payload.orgId) {
        throw new BadRequestException('orgId is required when linking an existing organization');
      }

      // A linked session lets a buyer attach this subscription (and its entitlements +
      // setup-fee billing) to an org. Only the org owner may do that, otherwise any
      // account-linked buyer could attach their subscription to an organization they do
      // not own. Verified over NATS against the organization service (source of truth).
      await this.assertUserOwnsOrganization(message.user.id, message.payload.orgId);

      // Only a still-live subscription blocks re-linking. A cancelled (Unsubscribed) prior
      // subscription must not block the cancel → re-subscribe → re-link the same org flow.
      const activeSubscription = await this.marketplaceRepository.getActiveSubscriptionByOrgId(
        message.payload.orgId
      );
      if (activeSubscription && activeSubscription.id !== session.subscription.id) {
        throw new ConflictException('Organization is already linked to another active Marketplace subscription');
      }

      await this.marketplaceRepository.linkOrganization(session.subscription.id, message.payload.orgId);
      await this.marketplaceRepository.updateOnboardingSession(session.id, 'org_linked');
      return { orgId: message.payload.orgId, nextAction: 'activate' };
    }

    if (!message.payload.organization?.name) {
      throw new BadRequestException('Organization name is required');
    }

    const organization = await this.sendNatsMessage(this.organizationClient, 'create-organization', {
      createOrgDto: {
        name: message.payload.organization.name,
        description: message.payload.organization.description,
        website: message.payload.organization.website,
        logo: message.payload.organization.logo || ''
      },
      userId: message.user.id,
      keycloakUserId: message.user.keycloakUserId
    });

    await this.marketplaceRepository.linkOrganization(session.subscription.id, organization.id);
    await this.marketplaceRepository.updateOnboardingSession(session.id, 'org_linked');
    return { orgId: organization.id, nextAction: 'activate' };
  }

  async activateSubscription(message: { sessionId: string; orgId: string; userId: string }): Promise<object> {
    const session = await this.getValidSession(message.sessionId);

    if (session.subscription.orgId !== message.orgId) {
      throw new BadRequestException('Marketplace subscription is not linked to the requested organization');
    }

    if (session.subscription.saasSubscriptionStatus === 'Subscribed') {
      await this.marketplaceRepository.setActivationStatus(session.subscription.id, 'activated');
      await this.marketplaceRepository.updateOnboardingSession(session.id, 'activated');
      await this.recordSetupFeeUsage(session.subscription, message.orgId);
      return {
        subscriptionId: session.subscription.marketplaceSubscriptionId,
        orgId: message.orgId,
        activationStatus: 'activated',
        saasSubscriptionStatus: 'Subscribed',
        dashboardUrl: '/organizations/dashboard'
      };
    }

    await this.marketplaceRepository.setActivationStatus(session.subscription.id, 'in_progress');

    try {
      if (this.localMockEnabled()) {
        await this.marketplaceRepository.setSubscriptionStatus(session.subscription.id, 'Subscribed');
        await this.marketplaceRepository.setActivationStatus(session.subscription.id, 'activated');
        await this.marketplaceRepository.updateOnboardingSession(session.id, 'activated');
        await this.recordSetupFeeUsage(session.subscription, message.orgId);
        return {
          subscriptionId: session.subscription.marketplaceSubscriptionId,
          orgId: message.orgId,
          activationStatus: 'activated',
          saasSubscriptionStatus: 'Subscribed',
          dashboardUrl: '/organizations/dashboard'
        };
      }

      await this.microsoftMarketplaceClient.activateSubscription(
        session.subscription.marketplaceSubscriptionId,
        session.subscription.planId
      );

      // MS returned 200 — activation was accepted. Set activated immediately without
      // waiting for getSubscription to confirm; MS may take a moment to flip
      // saasSubscriptionStatus to "Subscribed" and an immediate round-trip would leave
      // the subscription stuck at in_progress. Reconciliation will sync the final MS
      // status on the next hourly run.
      await this.marketplaceRepository.setActivationStatus(session.subscription.id, 'activated');
      await this.marketplaceRepository.updateOnboardingSession(session.id, 'activated');
      await this.recordSetupFeeUsage(session.subscription, message.orgId);

      // Best-effort refresh of term dates — do not let a getSubscription failure
      // roll back the activation that MS already confirmed.
      let latestSaasStatus: MarketplaceSubscriptionStatus = session.subscription.saasSubscriptionStatus;
      try {
        const latest = await this.microsoftMarketplaceClient.getSubscription(
          session.subscription.marketplaceSubscriptionId
        );
        const updated = await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
        latestSaasStatus = updated.saasSubscriptionStatus;
      } catch (refreshError) {
        this.logger.warn(
          `Could not refresh subscription status after activation: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`
        );
      }

      return {
        subscriptionId: session.subscription.marketplaceSubscriptionId,
        orgId: message.orgId,
        activationStatus: 'activated',
        saasSubscriptionStatus: latestSaasStatus,
        dashboardUrl: '/organizations/dashboard'
      };
    } catch (error) {
      await this.marketplaceRepository.setActivationStatus(
        session.subscription.id,
        'failed',
        error instanceof Error ? error.message : 'Activation failed'
      );
      await this.marketplaceRepository.updateOnboardingSession(session.id, 'failed');
      throw error;
    }
  }

  async getSubscription(message: { subscriptionId: string }): Promise<object> {
    const subscription = await this.marketplaceRepository.getSubscriptionByMarketplaceId(message.subscriptionId);
    if (!subscription) {
      throw new NotFoundException('Marketplace subscription not found');
    }
    return this.toSubscriptionSummary(subscription);
  }

  async refreshSubscription(message: { subscriptionId: string }): Promise<object> {
    const latest = await this.microsoftMarketplaceClient.getSubscription(message.subscriptionId);
    const updated = await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
    return this.toSubscriptionSummary(updated);
  }

  async processWebhook(message: { payload: MarketplaceWebhookPayload; authorization?: string }): Promise<object> {
    return this.webhookService.processWebhook(message.payload, message.authorization);
  }

  async getEntitlements(message: { orgId: string }): Promise<object> {
    return this.entitlementService.getEntitlements(message.orgId);
  }

  async getUsageSummary(message: { orgId: string; period?: string }): Promise<object> {
    const entitlements = await this.entitlementService.getEntitlements(message.orgId);
    const dimensions = Object.entries(entitlements.usage).map(([dimension, usage]) => ({
      dimension,
      displayName: this.displayNameForDimension(dimension),
      included: usage.included,
      used: usage.used,
      overage: usage.overage,
      pendingSubmission: 0,
      acceptedByMicrosoft: 0
    }));

    return {
      billingPeriod: {
        start: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString(),
        end: new Date().toISOString(),
        termUnit: 'P1M'
      },
      dimensions
    };
  }

  async getMeteringEvents(message: { orgId: string }): Promise<object> {
    return this.marketplaceRepository.listMeteringEvents(message.orgId);
  }

  async recordUsageEvent(payload: MarketplaceUsageEventPayload): Promise<object> {
    const subscription = await this.marketplaceRepository.getSubscriptionByOrgId(payload.orgId);
    await this.marketplaceRepository.recordBillingUsageEvent(payload, subscription?.id);
    return { recorded: true };
  }

  async submitMetering(): Promise<object> {
    await this.meteringService.aggregateAndSubmitUsage();
    return { submitted: true };
  }

  // Authorize that `userId` is an owner of `orgId` before linking a subscription to it.
  // Reuses the organization service's existing 'get-organization-owner' query (owner role)
  // rather than reaching into org tables from this microservice.
  private async assertUserOwnsOrganization(userId: string, orgId: string): Promise<void> {
    let ownerOrg: { userOrgRoles?: { user?: { id?: string } }[] } | null = null;
    try {
      ownerOrg = await this.sendNatsMessage<{ userOrgRoles?: { user?: { id?: string } }[] }>(
        this.organizationClient,
        'get-organization-owner',
        orgId
      );
    } catch (error) {
      this.logger.warn(
        `Marketplace org-ownership check failed for org ${orgId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw new ForbiddenException({
        code: 'marketplace_org_ownership_unverified',
        message: 'Unable to verify your ownership of the selected organization.'
      });
    }

    const isOwner =
      Array.isArray(ownerOrg?.userOrgRoles) && ownerOrg.userOrgRoles.some((role) => role?.user?.id === userId);

    if (!isOwner) {
      this.logger.warn(`Marketplace link_existing blocked: user is not an owner of org ${orgId}`);
      throw new ForbiddenException({
        code: 'marketplace_org_ownership_required',
        message: 'You can only link a Marketplace subscription to an organization you own.'
      });
    }
  }

  private async getValidSession(sessionId: string) {
    const session = await this.marketplaceRepository.getOnboardingSession(sessionId);
    if (!session || session.expiresAt < new Date()) {
      throw new NotFoundException('Marketplace onboarding session is missing or expired');
    }
    return session;
  }

  private async resolveWithMicrosoftOrMock(marketplaceToken: string): Promise<MarketplaceResolvedSubscription> {
    if (this.localMockEnabled()) {
      return {
        id: `mock-${this.hashToken(marketplaceToken).slice(0, 24)}`,
        name: 'Phenix ID Platform',
        offerId: process.env.MARKETPLACE_OFFER_ID || 'phenix-id-platform',
        planId: process.env.MARKETPLACE_DEFAULT_PLAN_ID || 'business',
        saasSubscriptionStatus: 'PendingFulfillmentStart',
        purchaser: { emailId: 'buyer@example.com' },
        beneficiary: { emailId: 'buyer@example.com' },
        term: {
          termUnit: 'P1M',
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        },
        autoRenew: true,
        isTest: true
      };
    }

    return this.microsoftMarketplaceClient.resolveSubscription(marketplaceToken);
  }

  private localMockEnabled(): boolean {
    return `${process.env.MARKETPLACE_ALLOW_LOCAL_MOCK}`.toLowerCase() === 'true';
  }

  private buyerFromClaims(
    claims: MarketplaceBuyerClaims | undefined,
    resolved: MarketplaceResolvedSubscription
  ): { tenantId?: string; objectId?: string; email?: string } {
    return {
      tenantId: claims?.tid || resolved.purchaser?.tenantId || resolved.beneficiary?.tenantId,
      objectId: claims?.oid || resolved.purchaser?.objectId || resolved.beneficiary?.objectId,
      email: claims?.email || claims?.preferred_username || resolved.purchaser?.emailId || resolved.beneficiary?.emailId
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private decodeMarketplaceToken(token: string): string {
    try {
      return decodeURIComponent(token);
    } catch {
      throw new BadRequestException('Marketplace token is malformed');
    }
  }

  private toSubscriptionSummary(subscription): object {
    return {
      subscriptionId: subscription.marketplaceSubscriptionId,
      offerId: subscription.offerId,
      planId: subscription.planId,
      subscriptionName: subscription.subscriptionName || 'Phenix ID Platform',
      saasSubscriptionStatus: subscription.saasSubscriptionStatus,
      localActivationStatus: subscription.activationStatus,
      linkedOrgId: subscription.orgId,
      purchaserEmail: subscription.purchaserEmail,
      beneficiaryEmail: subscription.beneficiaryEmail,
      quantity: subscription.quantity,
      termStartDate: subscription.termStartDate,
      termEndDate: subscription.termEndDate,
      autoRenew: subscription.autoRenew
    };
  }

  private nextAction(subscription): MarketplaceNextAction {
    if (
      subscription.saasSubscriptionStatus === 'Subscribed' &&
      subscription.orgId &&
      subscription.activationStatus === 'activated'
    ) {
      return 'open_dashboard';
    }
    if (!subscription.localUserId) {
      return 'link_account';
    }
    if (!subscription.orgId) {
      return 'create_organization';
    }
    if (subscription.activationStatus !== 'activated') {
      return 'activate';
    }
    return 'manage_billing';
  }

  private displayNameForDimension(dimension: string): string {
    const displayNames = {
      setup_fee: 'One-time setup fee',
      issuance_txn: 'Credential issuance',
      verification_txn: 'Credential verification',
      schema_create: 'Schema creation'
    };
    return displayNames[dimension] || dimension;
  }

  private async recordSetupFeeUsage(subscription, orgId: string): Promise<void> {
    await this.marketplaceRepository.recordBillingUsageEvent(
      {
        orgId,
        eventType: 'organization_setup_completed',
        sourceTable: 'marketplace_subscription',
        sourceId: subscription.id,
        quantity: 1,
        metadata: {
          dimension: 'setup_fee',
          unitPriceUsd: SETUP_FEE_USD
        }
      },
      subscription.id
    );
  }
}
