import { CommonModule } from '@credebl/common';
import { getNatsOptions } from '@credebl/common/nats.config';
import { CacheModule } from '@nestjs/cache-manager';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { PrismaService } from '@credebl/prisma-service';
import { NotificationRepository } from './notification.repository';
import { CommonConstants } from '@credebl/common/common.constant';

@Module({
  imports: [
    ConfigModule.forRoot(),
    ClientsModule.register([
      {
        name: 'NATS_CLIENT',
        transport: Transport.NATS,
        options: getNatsOptions(CommonConstants.NOTIFICATION_SERVICE, process.env.NOTIFICATION_NKEY_SEED)
      }
    ]),
    CommonModule,
    CacheModule.register({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT })
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationRepository, PrismaService, Logger]
})
export class NotificationModule { }