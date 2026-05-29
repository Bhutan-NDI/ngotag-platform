import { Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { NestFactory } from '@nestjs/core';
import { CommonConstants } from '@credebl/common/common.constant';
import { getNatsOptions } from '@credebl/common/nats.config';
import { HttpExceptionFilter } from 'libs/http-exception.filter';
import { MarketplaceModule } from './marketplace.module';

const logger = new Logger();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(MarketplaceModule, {
    transport: Transport.NATS,
    options: getNatsOptions(CommonConstants.MARKETPLACE_SERVICE, process.env.MARKETPLACE_NKEY_SEED)
  });

  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen();
  logger.log('Marketplace Microservice is listening to NATS');
}

bootstrap();
