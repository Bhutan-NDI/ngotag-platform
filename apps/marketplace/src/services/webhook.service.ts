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
        ackStatus: ['ChangePlan', 'ChangeQuantity'].includes(payload.action) ? 'pending' : 'not_required'
      });
    }

    if (['ChangePlan', 'ChangeQuantity', 'Reinstate'].includes(payload.action) && payload.id) {
      await this.microsoftMarketplaceClient.getOperation(payload.subscriptionId, payload.id);
    }

    if (payload.action === 'ChangePlan' && payload.planId) {
      const latest = await this.microsoftMarketplaceClient.getSubscription(payload.subscriptionId);
      await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
      await this.patchOperationIfNeeded(payload, true);
      return;
    }

    if (payload.action === 'ChangeQuantity') {
      const latest = await this.microsoftMarketplaceClient.getSubscription(payload.subscriptionId);
      await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
      await this.patchOperationIfNeeded(payload, true);
      return;
    }

    if (payload.action === 'Renew' || payload.action === 'Reinstate') {
      const latest = await this.microsoftMarketplaceClient.getSubscription(payload.subscriptionId);
      await this.marketplaceRepository.updateSubscriptionFromMicrosoft(latest);
      return;
    }

    if (payload.action === 'Suspend') {
      await this.marketplaceRepository.setSubscriptionStatus(subscriptionId, 'Suspended');
      return;
    }

    if (payload.action === 'Unsubscribe') {
      await this.marketplaceRepository.setSubscriptionStatus(subscriptionId, 'Unsubscribed');
    }
  }

  private async patchOperationIfNeeded(payload: MarketplaceWebhookPayload, success: boolean): Promise<void> {
    if (!payload.id) {
      return;
    }
    await this.microsoftMarketplaceClient.patchOperation(
      payload.subscriptionId,
      payload.id,
      success ? 'Success' : 'Failure'
    );
  }

  private async validateAuthorization(authorization?: string): Promise<void> {
    if (`${process.env.MARKETPLACE_WEBHOOK_VALIDATE_JWT}`.toLowerCase() !== 'true') {
      return;
    }

    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Marketplace webhook authorization is missing');
    }

    const token = authorization.replace('Bearer ', '');
    const decoded = jwt.decode(token, { complete: true });

    if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
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
