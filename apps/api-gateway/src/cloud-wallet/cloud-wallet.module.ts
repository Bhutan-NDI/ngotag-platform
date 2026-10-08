import { getNatsOptions } from '@credebl/common/nats.config';
import { CloudWalletController } from './cloud-wallet.controller';
import { CloudWalletService } from './cloud-wallet.service';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CommonConstants } from '@credebl/common/common.constant';
import { NATSClient } from '@credebl/common/NATSClient';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NATS_CLIENT',
        transport: Transport.NATS,
        options: getNatsOptions(
          CommonConstants.CLOUD_WALLET_SERVICE,
          process.env.API_GATEWAY_NKEY_SEED,
          process.env.NATS_CREDS_FILE
        )
      },
      // deleteCloudWallet's "also delete the holder user" step is a user-lifecycle operation
      // that belongs on apps/user's queue group, not apps/cloud-wallet's — see the #71 review's
      // "delete-user is dispatched on this.cloudWalletServiceProxy ... this would need
      // userServiceProxy".
      {
        name: 'USER_NATS_CLIENT',
        transport: Transport.NATS,
        options: getNatsOptions(
          CommonConstants.USER_SERVICE,
          process.env.API_GATEWAY_NKEY_SEED,
          process.env.NATS_CREDS_FILE
        )
      }
    ])
  ],
  controllers: [CloudWalletController],
  providers: [CloudWalletService, NATSClient]
})
export class CloudWalletModule {}
