import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ResponseType } from '../common/response';
import { CreateVerifierUser } from './dto/create-verifier-user.dto';
import { UpdateVerifierUser } from './dto/update-verifier-user.dto';
import { assertRole } from '../common/keycloak-roles.util';
import { OrgRoles } from 'libs/org-roles/enums';
import { ClientProxy } from '@nestjs/microservices';
import { NATSClient } from '@credebl/common/NATSClient';
import { CommonService } from '@credebl/common';
import { decryptClientCredential } from '@credebl/common/cast.helper';
import { PrismaService } from '@credebl/prisma-service';
import { randomBytes } from 'crypto';
import { decryptIfEncrypted } from '../common/functions';
import { VerifierWebhookRepository } from '../verifier-webhook/verifier-webhook.repository';
import { VerifierRoleRepository } from '../verifier-role/verifier-role.repository';
import { mobile_verifier_webhook_config as VerifierWebhookConfig } from '@prisma/client';

// The verifier-user record itself lives in the org's registered client system (see
// verifier-webhook), not the platform's own DB — mobile-verifier only owns role/proof-template
// config here. Shape mirrors CreateVerifierUser/UpdateVerifierUser plus an assigned verifierRoleId.
interface ExternalVerifierUser {
  id: string;
  email: string;
  verifierRoleId?: string;
  // Numeric status kept by the client system: 1 CREATED, 2 INVITED, 3 ACTIVE, 4 SUSPENDED, 5 REVOKED.
  statusId?: number;
  revocationStatus?: string;
  [key: string]: unknown;
}

const SUSPENDED_STATUS_ID = 4;
const REVOKED_STATUS_ID = 5;

// A fresh credential for a suspended or revoked user would undo the suspension/revocation.
const isSuspendedOrRevoked = (verifierUser: ExternalVerifierUser): boolean => {
  if (SUSPENDED_STATUS_ID === verifierUser.statusId || REVOKED_STATUS_ID === verifierUser.statusId) {
    return true;
  }
  const status = verifierUser.revocationStatus?.toUpperCase();
  return 'SUSPENDED' === status || 'REVOKED' === status;
};

@Injectable()
export class VerifierUserService {
  constructor(
    private readonly prismaService: PrismaService,
    @Inject('NATS_CLIENT') private readonly mobileVerifierProxy: ClientProxy,
    private readonly natsClient: NATSClient,
    private readonly commonService: CommonService,
    private readonly verifierWebhookRepository: VerifierWebhookRepository,
    private readonly verifierRoleRepository: VerifierRoleRepository
  ) {}

  // The client system stores the role name alongside the id (verifierRoleName is required on its
  // create/update DTOs). Roles live in this platform's DB, so resolve the name here instead of
  // making every caller send it, and refuse an id that isn't one of this organization's roles.
  private async findOrgRole(
    verifierRoleId: string,
    loginOrgId: string
  ): Promise<{ id: string; role: string } | undefined> {
    return (
      (await this.verifierRoleRepository.getVerifierRoleByWhere({ id: verifierRoleId, orgId: loginOrgId })) ?? undefined
    );
  }

  async createVerifierUser(
    userPayload: CreateVerifierUser,
    loginOrgId: string,
    authorization: string
  ): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    const role = await this.findOrgRole(userPayload.verifierRoleId, loginOrgId);
    if (!role) {
      return { statusCode: HttpStatus.BAD_REQUEST, message: 'Verifier role not found for this organization' };
    }

    const webhook = await this.verifierWebhookRepository.getWebhook(loginOrgId);

    if (!webhook) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'No verifier-user webhook registered for this organization'
      };
    }

    let authorizationHeader: string;
    try {
      authorizationHeader = await this.resolveWebhookAuthHeader(webhook);
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to authenticate with the registered verifier-user webhook'
      };
    }

    try {
      const url = `${webhook.webhookUrl}/v1/verifier-user`;
      const response = await this.commonService.httpPost(
        url,
        {
          firstName: userPayload.firstName,
          lastName: userPayload.lastName,
          username: userPayload.username,
          foundationID: userPayload.foundationID,
          email: userPayload.email,
          verifierRoleId: userPayload.verifierRoleId,
          verifierRoleName: role.role
        },
        { headers: { Authorization: authorizationHeader, 'Content-Type': 'application/json' } }
      );

      return {
        statusCode: HttpStatus.CREATED,
        message: response?.message ?? 'Verifier user created successfully',
        data: response?.data
      };
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to create verifier user via the registered webhook'
      };
    }
  }

  async getVerifierUsers(
    params: { id?: string; page?: number; pageSize?: number },
    loginOrgId: string
  ): Promise<ResponseType> {
    const { page = 1, pageSize = 10, id } = params;

    const webhook = await this.verifierWebhookRepository.getWebhook(loginOrgId);

    if (!webhook) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'No verifier-user webhook registered for this organization'
      };
    }

    let authorization: string;
    try {
      authorization = await this.resolveWebhookAuthHeader(webhook);
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to authenticate with the registered verifier-user webhook'
      };
    }

    if (id) {
      let verifierUser: ExternalVerifierUser | undefined;
      try {
        verifierUser = await this.getExternalVerifierUser(webhook, authorization, id);
      } catch (error) {
        return {
          statusCode: HttpStatus.BAD_GATEWAY,
          message: 'Failed to fetch verifier user from the registered webhook'
        };
      }

      if (!verifierUser) {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Verifier user not found'
        };
      }

      const [verifierUserWithOrgRole] = await this.withOrgRoleNames([verifierUser], loginOrgId);

      return {
        statusCode: HttpStatus.OK,
        message: 'Verifier user fetched successfully',
        data: verifierUserWithOrgRole
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any;
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      const url = `${webhook.webhookUrl}/v1/verifier-user?${query.toString()}`;
      response = await this.commonService.httpGet(url, { headers: { Authorization: authorization } });
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to fetch verifier users from the registered webhook'
      };
    }

    // The external contract wraps a [total, rows[]] tuple as `data` — unwrap defensively
    // in case a future version of the external service returns a plain array instead.
    const rawData = response?.data;
    const externalUsers: ExternalVerifierUser[] = Array.isArray(rawData?.[1])
      ? rawData[1]
      : Array.isArray(rawData)
        ? rawData
        : [];
    const verifierUsers = await this.withOrgRoleNames(externalUsers, loginOrgId);

    return {
      statusCode: HttpStatus.OK,
      message: response?.message ?? 'Verifier users fetched successfully',
      data: verifierUsers,
      pagination: response?.pagination ?? {
        total: verifierUsers.length,
        pageSize: verifierUsers.length,
        currentPage: Number(page),
        nextPage: null,
        prevPage: null
      }
    };
  }

  // verifierRoleName comes from the client system's own record, which can be stale: the role may
  // since have been removed, or the stored id may belong to another organization. Keep the stored
  // name only when the user's verifierRoleId is one of THIS organization's roles; otherwise blank it.
  private async withOrgRoleNames<T extends { verifierRoleId?: string | null; verifierRoleName?: string | null }>(
    users: T[],
    loginOrgId: string
  ): Promise<T[]> {
    const roleIds = [...new Set(users.map((user) => user.verifierRoleId).filter((id): id is string => Boolean(id)))];
    const orgRoleIds = new Set<string>();

    if (0 < roleIds.length) {
      const [, orgRoles] = await this.verifierRoleRepository.getVerifierRoles({
        where: { orgId: loginOrgId, id: { in: roleIds } }
      });
      orgRoles.forEach((orgRole) => orgRoleIds.add(orgRole.id));
    }

    return users.map((user) => ({
      ...user,
      verifierRoleName:
        user.verifierRoleId && orgRoleIds.has(user.verifierRoleId) ? (user.verifierRoleName ?? null) : null
    }));
  }

  async inviteVerifierUser(email: string, loginOrgId: string, authorization: string): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    const webhook = await this.verifierWebhookRepository.getWebhook(loginOrgId);

    if (!webhook) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'No verifier-user webhook registered for this organization'
      };
    }

    let authorizationHeader: string;
    try {
      authorizationHeader = await this.resolveWebhookAuthHeader(webhook);
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to authenticate with the registered verifier-user webhook'
      };
    }

    try {
      const url = `${webhook.webhookUrl}/v1/verifier-user/invite`;
      const response = await this.commonService.httpPost(
        url,
        { email },
        { headers: { Authorization: authorizationHeader, 'Content-Type': 'application/json' } }
      );

      return {
        statusCode: HttpStatus.CREATED,
        message: response?.message ?? 'Verifier user invited successfully',
        data: response?.data
      };
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to invite verifier user via the registered webhook'
      };
    }
  }

  async updateVerifierUserStatus(
    id: string,
    status: string,
    loginOrgId: string,
    authorization: string
  ): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    const webhook = await this.verifierWebhookRepository.getWebhook(loginOrgId);

    if (!webhook) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'No verifier-user webhook registered for this organization'
      };
    }

    let authorizationHeader: string;
    try {
      authorizationHeader = await this.resolveWebhookAuthHeader(webhook);
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to authenticate with the registered verifier-user webhook'
      };
    }

    try {
      const query = new URLSearchParams({ id, status });
      const url = `${webhook.webhookUrl}/v1/verifier-user/revoke_suspend?${query.toString()}`;
      const response = await this.commonService.httpPost(url, {}, { headers: { Authorization: authorizationHeader } });

      return {
        statusCode: HttpStatus.OK,
        message: response?.message ?? 'Verifier user status updated successfully',
        data: response?.data
      };
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to update verifier user status via the registered webhook'
      };
    }
  }

  // v2: the stored token is used directly as the bearer token. v1: exchanges the stored
  // client-credentials against the stored token URL first, per standard OAuth2 client-credentials
  // grant (RFC 6749 4.4) — this mirrors the "authentication" config verifier-webhook stores.
  private async resolveWebhookAuthHeader(webhook: VerifierWebhookConfig): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authData = webhook.authData as any;

    if ('v1' === webhook.authVersion) {
      const { grantType, clientSecret } = authData;
      const [url, clientId, decryptedSecret] = await Promise.all([
        decryptIfEncrypted(authData.url),
        decryptIfEncrypted(authData.clientId),
        decryptClientCredential(clientSecret)
      ]);

      const tokenResponse = await this.commonService.httpPost(
        url,
        // eslint-disable-next-line camelcase -- RFC 6749 token-request parameter names
        new URLSearchParams({ grant_type: grantType, client_id: clientId, client_secret: decryptedSecret }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      if (!tokenResponse?.access_token) {
        throw new Error('OAuth2 token endpoint did not return an access_token');
      }

      return `Bearer ${tokenResponse.access_token}`;
    }

    const decryptedToken = await decryptClientCredential(authData.token);
    return `Bearer ${decryptedToken}`;
  }

  private async getExternalVerifierUser(
    webhook: VerifierWebhookConfig,
    authorizationHeader: string,
    id: string
  ): Promise<ExternalVerifierUser | undefined> {
    // The client system has no GET /verifier-user/:id: it looks a user up with GET /verifier-user?id=,
    // and answers a missing user with HTTP 200 and a `statusCode: 404` body, so trust the body's status.
    const query = new URLSearchParams({ id });
    const url = `${webhook.webhookUrl}/v1/verifier-user?${query.toString()}`;
    const response = await this.commonService.httpGet(url, { headers: { Authorization: authorizationHeader } });
    return HttpStatus.OK === response?.statusCode ? response.data : undefined;
  }

  async updateVerifierUser(
    id: string,
    userPayload: UpdateVerifierUser,
    loginOrgId: string,
    authorization: string
  ): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    const role = await this.findOrgRole(userPayload.verifierRoleId, loginOrgId);
    if (!role) {
      return { statusCode: HttpStatus.BAD_REQUEST, message: 'Verifier role not found for this organization' };
    }

    const webhook = await this.verifierWebhookRepository.getWebhook(loginOrgId);

    if (!webhook) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'No verifier-user webhook registered for this organization'
      };
    }

    let authorizationHeader: string;
    try {
      authorizationHeader = await this.resolveWebhookAuthHeader(webhook);
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to authenticate with the registered verifier-user webhook'
      };
    }

    try {
      const url = `${webhook.webhookUrl}/v1/verifier-user/${encodeURIComponent(id)}`;
      const response = await this.commonService.httpPatch(
        url,
        {
          firstName: userPayload.firstName,
          lastName: userPayload.lastName,
          username: userPayload.username,
          foundationID: userPayload.foundationID,
          email: userPayload.email,
          verifierRoleId: userPayload.verifierRoleId,
          verifierRoleName: role.role
        },
        { headers: { Authorization: authorizationHeader, 'Content-Type': 'application/json' } }
      );

      return {
        statusCode: HttpStatus.OK,
        message: response?.message ?? 'Verifier user updated successfully',
        data: response?.data
      };
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to update verifier user via the registered webhook'
      };
    }
  }

  async sendCredentialIssuance(id: string, loginOrgId: string, authorization: string): Promise<ResponseType> {
    assertRole(authorization, loginOrgId, OrgRoles.ALLOW_VERIFIER);

    // JSON-LD schema of the Mobile Verifier credential; differs per environment (dev/stage/prod).
    const schemaUrl = process.env.MOBILE_VERIFIER_SCHEMA_URL;
    if (!schemaUrl) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'MOBILE_VERIFIER_SCHEMA_URL is not configured'
      };
    }

    const webhook = await this.verifierWebhookRepository.getWebhook(loginOrgId);

    if (!webhook) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'No verifier-user webhook registered for this organization'
      };
    }

    let authorizationHeader: string;
    try {
      authorizationHeader = await this.resolveWebhookAuthHeader(webhook);
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to authenticate with the registered verifier-user webhook'
      };
    }

    let verifierUser: ExternalVerifierUser | undefined;
    try {
      verifierUser = await this.getExternalVerifierUser(webhook, authorizationHeader, id);
    } catch (error) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'Failed to fetch verifier user from the registered webhook'
      };
    }

    if (!verifierUser) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Verifier user not found'
      };
    }

    if (isSuspendedOrRevoked(verifierUser)) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Cannot send an issuance invitation to a suspended or revoked verifier user'
      };
    }

    const verifierRole = verifierUser.verifierRoleId
      ? await this.verifierRoleRepository.getVerifierRoleByWhere({ id: verifierUser.verifierRoleId, orgId: loginOrgId })
      : null;

    if (!verifierRole) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Assign a role to this verifier user before sending an issuance invitation'
      };
    }

    const [organisation, primaryDid] = await Promise.all([
      this.prismaService.organisation.findFirst({ where: { id: loginOrgId }, select: { name: true } }),
      this.prismaService.org_dids.findFirst({
        // eslint-disable-next-line camelcase -- Prisma relation name
        where: { isPrimaryDid: true, org_agents: { orgId: loginOrgId } },
        select: { did: true }
      })
    ]);

    if (!primaryDid) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Organization has no DID yet — create one before sending an issuance invitation'
      };
    }

    const randomUsername = `Verifier-${randomBytes(3).toString('hex')}`;

    // JSON-LD credential offer shape, mirroring ngotag-studio's transformW3CData
    // (EmailIssuanceFunctions.tsx) — the same request shape the platform's issuance
    // microservice already handles end-to-end (OOB invitation, QR/deep-link generation,
    // email dispatch).
    const outOfBandCredentialDto = {
      orgId: loginOrgId,
      credentialType: 'jsonld',
      protocolVersion: 'v2',
      isReuseConnection: true,
      isValidateSchema: true,
      credentialOffer: [
        {
          emailId: verifierUser.email,
          credential: {
            '@context': ['https://www.w3.org/2018/credentials/v1', schemaUrl],
            type: ['VerifiableCredential', 'Mobile Verifier'],
            issuer: { id: primaryDid.did },
            issuanceDate: new Date().toISOString(),
            credentialSubject: {
              'User Name': randomUsername,
              Role: verifierRole.role,
              'Role ID': verifierRole.id,
              'Organization Name': organisation?.name ?? '',
              'Organization ID': loginOrgId
            }
          },
          // Ed25519Signature2018 / assertionMethod — ProofType.no_ledger in
          // ngotag-studio/src/common/enums.ts, for did:key / did:web issuers.
          options: { proofType: 'Ed25519Signature2018', proofPurpose: 'assertionMethod' }
        }
      ]
    };

    const result = await this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'out-of-band-credential-offer', {
      outOfBandCredentialDto
    });

    return {
      statusCode: HttpStatus.OK,
      message: 'Issuance invitation sent successfully',
      data: result
    };
  }
}
