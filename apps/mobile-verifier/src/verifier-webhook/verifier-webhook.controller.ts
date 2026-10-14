import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { ResponseType } from '../common/response';
import { VerifierWebhookService } from './verifier-webhook.service';
import { CreateVerifierWebhook } from './dto/create-verifier-webhook.dto';

@Controller()
export class VerifierWebhookController {
  constructor(private readonly verifierWebhookService: VerifierWebhookService) {}

  @MessagePattern({ cmd: 'register-verifier-webhook' })
  async registerVerifierWebhook(payload: {
    webhookPayload: CreateVerifierWebhook;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.verifierWebhookService.registerWebhook(
      payload.webhookPayload,
      payload.loginOrgId,
      payload.authorization
    );
  }

  @MessagePattern({ cmd: 'get-verifier-webhook' })
  async getVerifierWebhook(payload: { loginOrgId: string; webhookId?: string }): Promise<ResponseType> {
    return this.verifierWebhookService.getWebhook(payload.loginOrgId, payload.webhookId);
  }
}
