import { DevelopmentEnvironment } from '@credebl/enum/enum';
import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';

@Injectable()
export class ConfigService {
  constructor(private readonly configService: NestConfigService) {}

  get isProduction(): boolean {
    return DevelopmentEnvironment.PRODUCTION === this.environment;
  }

  get isDevelopment(): boolean {
    return DevelopmentEnvironment.DEVELOPMENT === this.environment;
  }

  get isTest(): boolean {
    return DevelopmentEnvironment.TEST === this.environment;
  }

  get slackWebhookUrl(): string {
    return this.configService.get<string>('SLACK_INC_WEBHOOK_URL');
  }

  // Trimmed/lowercased so a stray whitespace or a differently-cased value (e.g. LOG_FORMAT=JSON
  // from a secrets manager) doesn't silently fail the 'json' check and ship ANSI-colourised
  // output to CloudWatch instead.
  get logFormat(): string {
    return this.configService.get<string>('LOG_FORMAT')?.trim().toLowerCase();
  }

  private get environment(): string {
    return this.configService.get<string>('NODE_ENV');
  }
}
