import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { VerifierWebhookRepository } from './verifier-webhook.repository';
import { ResponseType } from '../common/response';
import { CreateVerifierWebhook } from './dto/create-verifier-webhook.dto';
import { assertRole } from '../common/keycloak-roles.util';
import { OrgRoles } from 'libs/org-roles/enums';
import { encryptClientCredential } from '@credebl/common/cast.helper';
import { decryptIfEncrypted } from '../common/functions';
import { Prisma } from '@prisma/client';

// Secrets (OAuth2 clientSecret / bearer token) are write-only: they are never sent back to callers.
const SECRET_MASK = '********';

@Injectable()
export class VerifierWebhookService {
  constructor(private readonly verifierWebhookRepository: VerifierWebhookRepository) {}

  async registerWebhook(
    webhookPayload: CreateVerifierWebhook,
    loginOrgId: string,
    authorization: string
  ): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    const { webhookId, webhookUrl, authentication } = webhookPayload;
    const { version, data } = authentication;

    const encryptedData = await this.encryptAuthData(version, data);

    const webhook = await this.verifierWebhookRepository.upsertWebhook(loginOrgId, webhookId, {
      webhookUrl,
      authType: authentication.type,
      authVersion: version,
      authData: encryptedData as Prisma.InputJsonValue
    });

    return {
      statusCode: HttpStatus.CREATED,
      message: 'Verifier webhook registered successfully',
      data: await this.toResponseShape(webhook)
    };
  }

  async getWebhook(loginOrgId: string, authorization: string, webhookId?: string): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    const webhook = await this.verifierWebhookRepository.getWebhook(loginOrgId, webhookId);

    if (!webhook) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Verifier webhook not found'
      };
    }

    return {
      statusCode: HttpStatus.OK,
      message: 'Verifier webhook fetched successfully',
      data: await this.toResponseShape(webhook)
    };
  }

  private async encryptAuthData(
    version: 'v1' | 'v2',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if ('v1' === version) {
      const { url, grantType, clientId, clientSecret } = data ?? {};
      if (!url || !grantType || !clientId || !clientSecret) {
        throw new HttpException(
          'url, grantType, clientId and clientSecret are required for OAuth2 v1',
          HttpStatus.BAD_REQUEST
        );
      }
      return {
        url: await encryptClientCredential(url),
        grantType,
        clientId: await encryptClientCredential(clientId),
        clientSecret: await encryptClientCredential(clientSecret)
      };
    }

    const { token } = data ?? {};
    if (!token) {
      throw new HttpException('token is required for OAuth2 v2', HttpStatus.BAD_REQUEST);
    }
    return { token: await encryptClientCredential(token) };
  }

  private async toResponseShape(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webhook: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authData = webhook.authData as any;

    const responseAuthData =
      'v1' === webhook.authVersion
        ? {
            ...authData,
            url: await decryptIfEncrypted(authData.url),
            clientId: await decryptIfEncrypted(authData.clientId),
            clientSecret: SECRET_MASK
          }
        : { token: SECRET_MASK };

    return {
      webhookId: webhook.webhookId,
      webhookUrl: webhook.webhookUrl,
      authentication: {
        type: webhook.authType,
        version: webhook.authVersion,
        data: responseAuthData
      }
    };
  }
}
