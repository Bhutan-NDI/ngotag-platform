import { ClientsModule, Transport } from '@nestjs/microservices';
import { Module } from '@nestjs/common';
import { ProofTemplateController } from './proof-template.controller';
import { ProofTemplateService } from './proof-template.service';
import { VerifierRoleController } from './verifier-role.controller';
import { VerifierRoleService } from './verifier-role.service';
import { VerifierUserController } from './verifier-user.controller';
import { VerifierUserService } from './verifier-user.service';
import { VerifierWebhookController } from './verifier-webhook.controller';
import { VerifierWebhookService } from './verifier-webhook.service';
import { getNatsOptions } from '@credebl/common/nats.config';
import { CommonConstants } from '@credebl/common/common.constant';
import { NATSClient } from '@credebl/common/NATSClient';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NATS_CLIENT',
        transport: Transport.NATS,
        options: getNatsOptions(
          CommonConstants.MOBILE_VERIFIER_SERVICE,
          process.env.API_GATEWAY_NKEY_SEED,
          process.env.NATS_CREDS_FILE
        )
      }
    ])
  ],
  controllers: [ProofTemplateController, VerifierRoleController, VerifierUserController, VerifierWebhookController],
  providers: [ProofTemplateService, VerifierRoleService, VerifierUserService, VerifierWebhookService, NATSClient]
})
export class MobileVerifierModule {}
