import { NestFactory } from '@nestjs/core';
import { HttpExceptionFilter } from 'libs/http-exception.filter';
import { Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { MobileVerifierModule } from '../src/mobile-verifier.module';
import { getNatsOptions } from '@credebl/common/nats.config';
import { CommonConstants } from '@credebl/common/common.constant';
import NestjsLoggerServiceAdapter from '@credebl/logger/nestjsLoggerServiceAdapter';

const logger = new Logger();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(MobileVerifierModule, {
    transport: Transport.NATS,
    options: getNatsOptions(
      CommonConstants.MOBILE_VERIFIER_SERVICE,
      process.env.MOBILE_VERIFIER_NKEY_SEED,
      process.env.NATS_CREDS_FILE
    )
  });
  app.useLogger(app.get(NestjsLoggerServiceAdapter));
  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen();
  logger.log('Mobile-Verifier-Service Microservice is listening to NATS ');
}
bootstrap();
