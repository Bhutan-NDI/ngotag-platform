import { Controller, Logger } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { WebhookService } from './webhook.service';
import { ICreateWebhookUrl, IGetWebhookUrl, IWebhookDto } from '../interfaces/webhook.interfaces';
import { IWebhookUrl } from '@credebl/common/interfaces/webhook.interface';

@Controller()
export class WebhookController {
  private readonly logger = new Logger('webhookService');
  constructor(private readonly webhookService: WebhookService) {}

  @MessagePattern({ cmd: 'register-webhook' })
  async registerWebhook(payload: { registerWebhookDto: IWebhookDto }): Promise<ICreateWebhookUrl> {
    return this.webhookService.registerWebhook(payload.registerWebhookDto);
  }

  @MessagePattern({ cmd: 'get-webhookurl' })
  async getWebhookUrl(payload: IWebhookUrl): Promise<IGetWebhookUrl> {
    return this.webhookService.getWebhookUrl(payload);
  }

  @MessagePattern({ cmd: 'post-webhook-response-to-webhook-url' })
  async webhookResponse(payload: { webhookUrl: string; data: object }): Promise<object> {
    return this.webhookService.webhookResponse(payload.webhookUrl, payload.data);
  }
}
