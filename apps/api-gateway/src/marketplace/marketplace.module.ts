import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule } from '@nestjs/config';
import { Global, Module } from '@nestjs/common';
import { CommonConstants } from '@credebl/common/common.constant';
import { getNatsOptions } from '@credebl/common/nats.config';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceEntitlementGuard } from './guards/marketplace-entitlement.guard';
import { MarketplaceService } from './marketplace.service';
import { NATSClient } from '@credebl/common/NATSClient';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot(),
    ClientsModule.register([
      {
        name: 'NATS_CLIENT',
        transport: Transport.NATS,
        options: getNatsOptions(CommonConstants.MARKETPLACE_SERVICE, process.env.API_GATEWAY_NKEY_SEED, process.env.NATS_CREDS_FILE)
      }
    ])
  ],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, MarketplaceEntitlementGuard, NATSClient],
  exports: [MarketplaceService, MarketplaceEntitlementGuard]
})
export class MarketplaceModule {}
