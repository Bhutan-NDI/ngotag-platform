import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { MarketplaceResolvedSubscription } from '../interfaces/marketplace.interface';
import { PublisherTokenService } from './publisher-token.service';

interface MarketplaceClientResponse<T> {
  data: T;
  requestId: string;
  correlationId: string;
}

interface MarketplaceResolveResponse {
  id?: string;
  subscriptionName?: string;
  offerId?: string;
  planId?: string;
  quantity?: number;
  subscription?: MarketplaceResolvedSubscription;
  [key: string]: unknown;
}

@Injectable()
export class MicrosoftMarketplaceClient {
  private readonly apiBaseUrl = process.env.MARKETPLACE_API_BASE_URL || 'https://marketplaceapi.microsoft.com';
  private readonly apiVersion = process.env.MARKETPLACE_API_VERSION || '2018-08-31';

  constructor(
    private readonly httpService: HttpService,
    private readonly publisherTokenService: PublisherTokenService
  ) {}

  async resolveSubscription(marketplaceToken: string): Promise<MarketplaceResolvedSubscription> {
    const response = await this.request<MarketplaceResolveResponse>(
      'post',
      '/api/saas/subscriptions/resolve',
      undefined,
      {
        'x-ms-marketplace-token': marketplaceToken
      }
    );
    // SaaS Fulfillment API v2 wraps the subscription (with purchaser/beneficiary/term/
    // saasSubscriptionStatus) under a `subscription` property; only id/subscriptionName/
    // offerId/planId/quantity live at the top level. getSubscription returns it flat.
    // Normalize to the flat shape used by the rest of the service.
    const body = response.data;
    const nested = body.subscription;
    if (!nested) {
      return body as MarketplaceResolvedSubscription;
    }
    return {
      ...nested,
      id: nested.id ?? body.id,
      name: nested.name ?? body.subscriptionName
    } as MarketplaceResolvedSubscription;
  }

  async activateSubscription(subscriptionId: string, planId: string): Promise<unknown> {
    const response = await this.request('post', `/api/saas/subscriptions/${subscriptionId}/activate`, { planId });
    return response.data;
  }

  async getSubscription(subscriptionId: string): Promise<MarketplaceResolvedSubscription> {
    const response = await this.request<MarketplaceResolvedSubscription>(
      'get',
      `/api/saas/subscriptions/${subscriptionId}`
    );
    return response.data;
  }

  async listSubscriptions(): Promise<MarketplaceResolvedSubscription[]> {
    const response = await this.request<
      { subscriptions?: MarketplaceResolvedSubscription[] } | MarketplaceResolvedSubscription[]
    >('get', '/api/saas/subscriptions');
    return Array.isArray(response.data) ? response.data : response.data.subscriptions || [];
  }

  async getOperation(subscriptionId: string, operationId: string): Promise<unknown> {
    const response = await this.request('get', `/api/saas/subscriptions/${subscriptionId}/operations/${operationId}`);
    return response.data;
  }

  async patchOperation(subscriptionId: string, operationId: string, status: 'Success' | 'Failure'): Promise<unknown> {
    const response = await this.request(
      'patch',
      `/api/saas/subscriptions/${subscriptionId}/operations/${operationId}`,
      { status }
    );
    return response.data;
  }

  async submitBatchUsageEvents(
    events: {
      resourceId: string;
      quantity: number;
      dimension: string;
      effectiveStartTime: string;
    }[]
  ): Promise<MarketplaceClientResponse<unknown>> {
    // Microsoft's batchUsageEvent schema does not include planId per line item.
    return this.request('post', '/api/batchUsageEvent', { request: events });
  }

  private async request<T>(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<MarketplaceClientResponse<T>> {
    const token = await this.publisherTokenService.getAccessToken();
    const requestId = randomUUID();
    const correlationId = randomUUID();
    const separator = path.includes('?') ? '&' : '?';
    const url = `${this.apiBaseUrl}${path}${separator}api-version=${this.apiVersion}`;
    const config = {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-ms-requestid': requestId,
        'x-ms-correlationid': correlationId,
        ...extraHeaders
      }
    };

    const response = await firstValueFrom(
      'get' === method || 'delete' === method
        ? this.httpService[method]<T>(url, config)
        : this.httpService[method]<T>(url, body, config)
    );

    return {
      data: response.data,
      requestId,
      correlationId
    };
  }
}
