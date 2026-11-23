import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CommonModule } from '@credebl/common';
import { GlobalConfigModule } from '@credebl/config/global-config.module';
import { ConfigModule as PlatformConfig } from '@credebl/config/config.module';
import { LoggerModule } from '@credebl/logger/logger.module';
import { ContextInterceptorModule } from '@credebl/context/contextInterceptorModule';
import { getNatsOptions } from '@credebl/common/nats.config';
import { CommonConstants } from '@credebl/common/common.constant';
import { NATSClient } from '@credebl/common/NATSClient';
import { PrismaService } from '@credebl/prisma-service';
import { ProofTemplateController } from './proof-template/proof-template.controller';
import { ProofTemplateService } from './proof-template/proof-template.service';
import { ProofTemplateRepo } from './proof-template/proof-template.repository';
import { VerifierRoleController } from './verifier-role/verifier-role.controller';
import { VerifierRoleService } from './verifier-role/verifier-role.service';
import { VerifierRoleRepository } from './verifier-role/verifier-role.repository';
import { VerifierUserController } from './verifier-user/verifier-user.controller';
import { VerifierUserService } from './verifier-user/verifier-user.service';
import { VerifierWebhookController } from './verifier-webhook/verifier-webhook.controller';
import { VerifierWebhookService } from './verifier-webhook/verifier-webhook.service';
import { VerifierWebhookRepository } from './verifier-webhook/verifier-webhook.repository';

@Module({
  imports: [
    ConfigModule.forRoot(),
    ClientsModule.register([
      {
        name: 'NATS_CLIENT',
        transport: Transport.NATS,
        options: getNatsOptions(
          CommonConstants.MOBILE_VERIFIER_SERVICE,
          process.env.MOBILE_VERIFIER_NKEY_SEED,
          process.env.NATS_CREDS_FILE
        )
      }
    ]),
    CommonModule,
    GlobalConfigModule,
    LoggerModule,
    PlatformConfig,
    ContextInterceptorModule
  ],
  controllers: [ProofTemplateController, VerifierRoleController, VerifierUserController, VerifierWebhookController],
  providers: [
    PrismaService,
    Logger,
    ProofTemplateService,
    ProofTemplateRepo,
    VerifierRoleService,
    VerifierRoleRepository,
    VerifierUserService,
    VerifierWebhookService,
    VerifierWebhookRepository,
    NATSClient
  ]
})
export class MobileVerifierModule {}
