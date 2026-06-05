import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as jwksRsa from 'jwks-rsa';
import { MarketplaceWebhookPayload } from '../interfaces/marketplace.interface';
import { MarketplaceRepository } from '../repositories/marketplace.repository';
import { MicrosoftMarketplaceClient } from './microsoft-marketplace.client';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger('WebhookService');

  constructor(
    private readonly marketplaceRepository: MarketplaceRepository,
    private readonly microsoftMarketplaceClient: MicrosoftMarketplaceClient
  ) {}

  async processWebhook(payload: MarketplaceWebhookPayload, authorization?: string): Promise<{ received: boolean }> {
    await this.validateAuthorization(authorization);

    if (payload.offerId !== process.env.MARKETPLACE_OFFER_ID) {
      throw new BadRequestException('Marketplace offer mismatch');
    }

    const subscription = await this.marketplaceRepository.getSubscriptionByMarketplaceId(payload.subscriptionId);
    const webhookEvent = await this.marketplaceRepository.createWebhookEvent({
      operationId: payload.id,
      activityId: payload.activityId,
      subscriptionId: payload.subscriptionId,
      marketplaceSubscriptionId: subscription?.id,
      action: payload.action,
      status: payload.status,
      body: JSON.parse(JSON.stringify(payload)),
      headers: authorization ? { authorization: 'Bearer [redacted]' } : {},
      validationStatus: 'validated'
    });

    if (!subscription) {
      await this.marketplaceRepository.updateWebhookEvent(webhookEvent.id, 'failed', 'Subscription not found');
      throw new BadRequestException('Marketplace subscription not found');
    }

    try {
      await this.applyWebhookAction(subscription.id, payload);
      await this.marketplaceRepository.updateWebhookEvent(webhookEvent.id, 'processed');
      return { received: true };
    } catch (error) {
      await this.marketplaceRepository.updateWebhookEvent(
        webhookEvent.id,
        'failed',
        error instanceof Error ? error.message : 'Webhook processing failed'
      );
      throw error;
    }
  }

  private async applyWebhookAction(subscriptionId: string, payload: MarketplaceWebhookPayload): Promise<void> {
    if (payload.id) {
      await this.marketplaceRepository.upsertOperation({
        operationId: payload.id,
        subscriptionId,
        action: payload.action,
        status: payload.status,
        planId: payload.planId,
        quantity: payload.quantity,
        rawPayload: JSON.parse(JSON.stringify(payload)),
        ackStatus: ['ChangePlan', 'ChangeQuantity', 'Reinstate'].includes(payload.action) ? 'pending' : 'not_required'
      });
    }

    if (['ChangePlan', 'ChangeQuantity', 'Reinstate'].includes(payload.action) && payload.id) {
      await this.microsoftMarketplaceClient.getOperation(payload.subscriptionId, payload.id);
    }

    if ('ChangePlan' === payload.action && payload.planId) {
      const latest = await this.microsoftMarketplaceClient.getSubscription(payload.subscriptionId);
      await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
      // MS may not have committed the new plan yet when getSubscription is called, so the
      // response can still carry the old planId. Explicitly set the target plan from the
      // webhook payload which always reflects the intended new plan.
      await this.marketplaceRepository.setSubscriptionPlanId(subscriptionId, payload.planId);
      await this.patchOperationIfNeeded(payload, true);
      if (payload.id) {
        await this.marketplaceRepository.updateOperationAckStatus(payload.id, subscriptionId, 'success');
      }
      return;
    }

    if ('ChangeQuantity' === payload.action) {
      const latest = await this.microsoftMarketplaceClient.getSubscription(payload.subscriptionId);
      await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
      await this.patchOperationIfNeeded(payload, true);
      if (payload.id) {
        await this.marketplaceRepository.updateOperationAckStatus(payload.id, subscriptionId, 'success');
      }
      return;
    }

    if ('Renew' === payload.action) {
      const latest = await this.microsoftMarketplaceClient.getSubscription(payload.subscriptionId);
      await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
      return;
    }

    if ('Reinstate' === payload.action) {
      const latest = await this.microsoftMarketplaceClient.getSubscription(payload.subscriptionId);
      await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
      // Reinstate requires a Success acknowledgement back to MS, otherwise MS will
      // keep retrying the webhook. This was previously missing (P1 bug).
      await this.patchOperationIfNeeded(payload, true);
      if (payload.id) {
        await this.marketplaceRepository.updateOperationAckStatus(payload.id, subscriptionId, 'success');
      }
      return;
    }

    if ('Suspend' === payload.action) {
      await this.marketplaceRepository.setSubscriptionStatus(subscriptionId, 'Suspended');
      return;
    }

    if ('Unsubscribe' === payload.action) {
      await this.marketplaceRepository.setSubscriptionStatus(subscriptionId, 'Unsubscribed');
    }
  }

  private async patchOperationIfNeeded(payload: MarketplaceWebhookPayload, success: boolean): Promise<void> {
    if (!payload.id) {
      return;
    }
    const planId = 'ChangePlan' === payload.action ? payload.planId : undefined;
    const quantity = 'ChangeQuantity' === payload.action ? payload.quantity : undefined;
    try {
      await this.microsoftMarketplaceClient.patchOperation(
        payload.subscriptionId,
        payload.id,
        success ? 'Success' : 'Failure',
        planId,
        quantity
      );
    } catch (error: unknown) {
      // A 400 from MS on the operation PATCH usually means the operation is no longer in
      // progress (already completed/expired on the MS side). Re-throwing would mark the
      // webhook failed and MS would keep retrying the same dead operation forever. Log the
      // detailed reason (now includes the MS response body) and swallow the 400 so the
      // webhook returns success and MS stops retrying. Any other error still propagates.
      const status =
        (error as { status?: number; response?: { status?: number } })?.status ??
        (error as { response?: { status?: number } })?.response?.status;
      if (400 === status) {
        this.logger.warn(
          `patchOperation 400 for operationId=${payload.id} action=${payload.action}: ${
            error instanceof Error ? error.message : JSON.stringify(error)
          }`
        );
        return;
      }
      throw error;
    }
  }

  private async validateAuthorization(authorization?: string): Promise<void> {
    if ('true' !== `${process.env.MARKETPLACE_WEBHOOK_VALIDATE_JWT}`.toLowerCase()) {
      return;
    }

    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Marketplace webhook authorization is missing');
    }

    const token = authorization.replace('Bearer ', '');
    const decoded = jwt.decode(token, { complete: true });

    if (!decoded || 'string' === typeof decoded || !decoded.header.kid) {
      throw new UnauthorizedException('Marketplace webhook token is invalid');
    }

    const tenantId = process.env.MARKETPLACE_TENANT_ID;
    const expectedAudience = process.env.MARKETPLACE_WEBHOOK_EXPECTED_AUDIENCE;
    const expectedAppId = process.env.MARKETPLACE_WEBHOOK_EXPECTED_APP_ID;

    if (!tenantId || !expectedAudience) {
      throw new UnauthorizedException('Marketplace webhook validation config is missing');
    }

    const client = jwksRsa({ jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys` });
    const signingKey = await client.getSigningKey(decoded.header.kid);
    const verified = jwt.verify(token, signingKey.getPublicKey(), { audience: expectedAudience }) as jwt.JwtPayload;

    if (expectedAppId && verified.appid !== expectedAppId && verified.azp !== expectedAppId) {
      this.logger.warn('Marketplace webhook app id mismatch');
      throw new UnauthorizedException('Marketplace webhook app id mismatch');
    }
  }
}
