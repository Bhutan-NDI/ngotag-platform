import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { NATSClient } from '@credebl/common/NATSClient';
import { IResponse } from '@credebl/common/interfaces/response.interface';
import { CreateVerifierWebhook } from './dto/create-verifier-webhook.dto';

@Injectable()
export class VerifierWebhookService {
  constructor(
    @Inject('NATS_CLIENT') private readonly mobileVerifierProxy: ClientProxy,
    private readonly natsClient: NATSClient
  ) {}

  async registerVerifierWebhook(
    webhookPayload: CreateVerifierWebhook,
    loginOrgId: string,
    authorization: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'register-verifier-webhook', {
      webhookPayload,
      loginOrgId,
      authorization
    });
  }

  async getVerifierWebhook(loginOrgId: string, webhookId?: string): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'get-verifier-webhook', {
      loginOrgId,
      webhookId
    });
  }
}
