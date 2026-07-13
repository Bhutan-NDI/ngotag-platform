import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

interface PublisherTokenResponse {
  access_token: string;
  expires_in: number;
}

@Injectable()
export class PublisherTokenService {
  private readonly logger = new Logger('PublisherTokenService');
  private cachedToken?: { token: string; expiresAt: number };

  constructor(private readonly httpService: HttpService) {}

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.token;
    }

    const tenantId = process.env.MARKETPLACE_TENANT_ID;
    const clientId = process.env.MARKETPLACE_CLIENT_ID;
    const clientSecret = process.env.MARKETPLACE_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
      throw new UnauthorizedException('Marketplace publisher credentials are not configured');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: '20e940b3-4c77-4b0b-9a53-9e16a1b010a7/.default'
    });

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<PublisherTokenResponse>(tokenUrl, body.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        })
      );

      this.cachedToken = {
        token: response.data.access_token,
        expiresAt: Date.now() + response.data.expires_in * 1000
      };

      return response.data.access_token;
    } catch (error) {
      this.logger.error('Failed to acquire Marketplace publisher token');
      throw error;
    }
  }
}
