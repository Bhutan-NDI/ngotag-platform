import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { Logger, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonConstants } from '@credebl/common/common.constant';
import { getNatsOptions } from '@credebl/common/nats.config';
import { PrismaService } from '@credebl/prisma-service';
import { EntitlementService } from './services/entitlement.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceRepository } from './repositories/marketplace.repository';
import { MarketplaceService } from './marketplace.service';
import { MeteringService } from './services/metering.service';
import { MicrosoftMarketplaceClient } from './services/microsoft-marketplace.client';
import { PublisherTokenService } from './services/publisher-token.service';
import { ReconciliationService } from './services/reconciliation.service';
import { WebhookService } from './services/webhook.service';

@Module({
  imports: [
    ConfigModule.forRoot(),
    HttpModule,
    ScheduleModule.forRoot(),
    ClientsModule.register([
      {
        name: 'ORGANIZATION_CLIENT',
        transport: Transport.NATS,
        options: getNatsOptions(CommonConstants.ORGANIZATION_SERVICE, process.env.MARKETPLACE_NKEY_SEED)
      }
    ])
  ],
  controllers: [MarketplaceController],
  providers: [
    MarketplaceService,
    MarketplaceRepository,
    MicrosoftMarketplaceClient,
    PublisherTokenService,
    EntitlementService,
    MeteringService,
    ReconciliationService,
    WebhookService,
    PrismaService,
    Logger
  ]
})
export class MarketplaceModule {}
