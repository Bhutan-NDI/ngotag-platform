import { SetMetadata } from '@nestjs/common';

export const MARKETPLACE_FEATURE_KEY = 'marketplace_feature';

export type MarketplaceFeature =
  | 'schemaCreate'
  | 'credentialDefinitionCreate'
  | 'issuance'
  | 'bulkIssuance'
  | 'verification'
  | 'apiAccess';

export const RequiresMarketplaceFeature = (feature: MarketplaceFeature): ReturnType<typeof SetMetadata> =>
  SetMetadata(MARKETPLACE_FEATURE_KEY, feature);
