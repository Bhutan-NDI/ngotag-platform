export type MarketplaceSubscriptionStatus = 'PendingFulfillmentStart' | 'Subscribed' | 'Suspended' | 'Unsubscribed';
export type MarketplaceActivationStatus = 'not_started' | 'in_progress' | 'activated' | 'failed';
export type MarketplaceNextAction =
  | 'link_account'
  | 'create_organization'
  | 'activate'
  | 'open_dashboard'
  | 'manage_billing';

export interface MarketplaceBuyerClaims {
  tid?: string;
  oid?: string;
  email?: string;
  preferred_username?: string;
  name?: string;
}

export interface ResolveMarketplacePayload {
  marketplaceToken: string;
  microsoftIdToken?: string;
  buyerClaims?: MarketplaceBuyerClaims;
}

export interface MarketplaceResolvedSubscription {
  id: string;
  name?: string;
  publisherId?: string;
  offerId: string;
  planId: string;
  saasSubscriptionStatus: MarketplaceSubscriptionStatus;
  beneficiary?: MarketplaceParty;
  purchaser?: MarketplaceParty;
  term?: {
    termUnit?: string;
    startDate?: string;
    endDate?: string;
  };
  autoRenew?: boolean;
  isFreeTrial?: boolean;
  isTest?: boolean;
  sandboxType?: string;
  quantity?: number;
  allowedCustomerOperations?: string[];
  [key: string]: unknown;
}

export interface MarketplaceParty {
  emailId?: string;
  tenantId?: string;
  objectId?: string;
  puid?: string;
}

export interface MarketplaceWebhookPayload {
  id?: string;
  activityId?: string;
  publisherId?: string;
  offerId: string;
  planId?: string;
  quantity?: number;
  subscriptionId: string;
  timeStamp?: string;
  action: 'ChangePlan' | 'ChangeQuantity' | 'Renew' | 'Suspend' | 'Unsubscribe' | 'Reinstate';
  status?: string;
  operationRequestSource?: string;
  subscription?: unknown;
  purchaseToken?: string | null;
  [key: string]: unknown;
}

export interface MarketplaceUsageEventPayload {
  orgId: string;
  eventType: string;
  sourceTable?: string;
  sourceId: string;
  occurredAt?: string;
  quantity?: number;
  metadata?: Record<string, unknown>;
}

export interface MarketplaceEntitlementResponse {
  orgId: string;
  subscription?: {
    subscriptionId: string;
    status: MarketplaceSubscriptionStatus;
    planId: string;
  };
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
  usage: Record<string, { included: number; used: number; overage: number }>;
  blockedReason: string | null;
}
