import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { envMs } from './migration-job-poller';

export interface IAgentRuntimeConfig {
  autoAcceptConnections: boolean;
  autoAcceptCredentials: string;
  autoAcceptProofs: string;
  inboundTransports: string[];
  outboundTransports: string[];
  cronPurgeEnabled: boolean;
}

export interface IAgentInfo {
  label?: string;
  endpoints: string[];
  isInitialized: boolean;
  releaseVersion?: string;
  storageVersion?: string;
  config?: IAgentRuntimeConfig;
}

export interface IPortabilityJob {
  jobId: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  downloadUrl?: string;
  checksum?: string;
  sealedStoreKey?: string;
  storageVersion?: string;
  counts?: { entries: number; keys: number; skipped: number };
  error?: string;
}

export interface IImportSession {
  sessionId: string;
  importPublicKey: string;
}

export interface IEndpointSchemes {
  didsScanned: number;
  unresolvedDids?: number;
  schemes: { scheme: string; count: number; exampleDids: string[] }[];
}

export interface IRelayEntry {
  mode: 'HOLD' | 'FORWARD';
  target?: string;
  holdCount?: number;
}

export interface ISelfAttestedCredential {
  credential: Record<string, unknown>;
}

export interface ICreatedInvitation {
  invitationUrl: string;
  invitationDid?: string;
}

export type AgentErrorKind = 'UNREACHABLE' | 'REJECTED' | 'CONFLICT' | 'NOT_FOUND' | 'FAILED';

/**
 * A failed call to an agent. Carries the kind of failure and, for a conflict, the agent's own code (for example
 * TARGET_NOT_PRISTINE). It never carries the request, so a token cannot reach a log through it.
 */
export class MigrationAgentError extends Error {
  constructor(
    readonly kind: AgentErrorKind,
    readonly status?: number,
    readonly agentCode?: string
  ) {
    super(`Agent call failed: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'MigrationAgentError';
  }
}

const REQUEST_TIMEOUT_MS = 15000;
const REINJECT_TIMEOUT_MS = 10 * 60 * 1000;

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * The calls the migration makes to the shared agent (with the base-wallet token) and to the organisation's
 * dedicated agent (with its root token). It talks to axios directly instead of through CommonService, whose
 * error logging would write the authorization header of a failed call into the logs.
 */
@Injectable()
export class MigrationAgentClient {
  constructor(private readonly httpService: HttpService) {}

  private async request<T>(
    method: 'get' | 'post' | 'put' | 'delete',
    baseUrl: string,
    path: string,
    token: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.httpService.request<T>({
          method,
          url: `${trimSlash(baseUrl)}${path}`,
          data: body,
          headers: { authorization: token, accept: 'application/json' },
          timeout: timeoutMs
        })
      );
      return response.data;
    } catch (error) {
      const status: number | undefined = error?.response?.status;
      if (undefined === status) {
        throw new MigrationAgentError('UNREACHABLE');
      }
      if (401 === status || 403 === status) {
        throw new MigrationAgentError('REJECTED', status);
      }
      if (404 === status) {
        throw new MigrationAgentError('NOT_FOUND', status);
      }
      const message = error.response?.data?.message;
      throw new MigrationAgentError(
        409 === status ? 'CONFLICT' : 'FAILED',
        status,
        'string' === typeof message ? message : undefined
      );
    }
  }

  // The API key goes in the authorization header, as the agent expects; it is exchanged for the root token.
  async createToken(adminEndpoint: string, apiKey: string): Promise<string> {
    const { token } = await this.request<{ token: string }>('post', adminEndpoint, '/agent/token', apiKey, '');
    return token;
  }

  getAgentInfo(adminEndpoint: string, token: string): Promise<IAgentInfo> {
    return this.request('get', adminEndpoint, '/agent', token);
  }

  createImportSession(adminEndpoint: string, token: string): Promise<IImportSession> {
    return this.request('post', adminEndpoint, '/agent/wallet/import-session', token, {});
  }

  startImport(
    adminEndpoint: string,
    token: string,
    body: {
      sessionId: string;
      exportUrl: string;
      checksum: string;
      sealedStoreKey: string;
      storageVersion: string;
      dryRun: boolean;
    }
  ): Promise<IPortabilityJob> {
    return this.request('post', adminEndpoint, '/agent/wallet/import', token, body);
  }

  getImportJob(adminEndpoint: string, token: string, jobId: string): Promise<IPortabilityJob> {
    return this.request('get', adminEndpoint, `/agent/wallet/import/status/${encodeURIComponent(jobId)}`, token);
  }

  startSealedExport(
    sharedEndpoint: string,
    token: string,
    tenantId: string,
    recipientPublicKey: string
  ): Promise<IPortabilityJob> {
    return this.request('post', sharedEndpoint, `/multi-tenancy/export/${encodeURIComponent(tenantId)}`, token, {
      recipientPublicKey
    });
  }

  getExportJob(sharedEndpoint: string, token: string, tenantId: string, jobId: string): Promise<IPortabilityJob> {
    return this.request(
      'get',
      sharedEndpoint,
      `/multi-tenancy/export/${encodeURIComponent(tenantId)}/status/${encodeURIComponent(jobId)}`,
      token
    );
  }

  async deleteExport(sharedEndpoint: string, token: string, tenantId: string, jobId: string): Promise<void> {
    await this.request(
      'delete',
      sharedEndpoint,
      `/multi-tenancy/export/${encodeURIComponent(tenantId)}/${encodeURIComponent(jobId)}`,
      token
    );
  }

  getRelayHealth(sharedEndpoint: string, token: string): Promise<{ enabled: boolean; redisReady: boolean }> {
    return this.request('get', sharedEndpoint, '/multi-tenancy/relay/health', token);
  }

  probeRelayTarget(
    sharedEndpoint: string,
    token: string,
    tenantId: string,
    target: string
  ): Promise<{ reachable: boolean; status?: number; reason?: string }> {
    return this.request('post', sharedEndpoint, `/multi-tenancy/relay/${encodeURIComponent(tenantId)}/probe`, token, {
      target
    });
  }

  getEndpointSchemes(sharedEndpoint: string, token: string, tenantId: string): Promise<IEndpointSchemes> {
    return this.request(
      'get',
      sharedEndpoint,
      `/multi-tenancy/${encodeURIComponent(tenantId)}/endpoint-schemes`,
      token
    );
  }

  putRelay(
    sharedEndpoint: string,
    token: string,
    tenantId: string,
    body: { mode: 'HOLD' | 'FORWARD'; target?: string }
  ): Promise<IRelayEntry> {
    return this.request('put', sharedEndpoint, `/multi-tenancy/relay/${encodeURIComponent(tenantId)}`, token, body);
  }

  // The agent re-injects synchronously, and can wait up to ten seconds for each held message.
  reinjectRelay(
    sharedEndpoint: string,
    token: string,
    tenantId: string
  ): Promise<{ injected: number; failed: number }> {
    return this.request(
      'post',
      sharedEndpoint,
      `/multi-tenancy/relay/${encodeURIComponent(tenantId)}/reinject`,
      token,
      {},
      envMs('ORG_MIGRATION_REINJECT_TIMEOUT_MS', REINJECT_TIMEOUT_MS)
    );
  }

  async deleteRelay(sharedEndpoint: string, token: string, tenantId: string): Promise<void> {
    await this.request('delete', sharedEndpoint, `/multi-tenancy/relay/${encodeURIComponent(tenantId)}`, token);
  }

  // The agent signs with its own default DID, so only the claims are given.
  createSelfAttestedCredential(
    adminEndpoint: string,
    token: string,
    body: {
      '@context': string[];
      type: string[];
      credentialSubject: Record<string, unknown>;
      proofType: string;
      did?: string;
    }
  ): Promise<ISelfAttestedCredential> {
    return this.request('post', adminEndpoint, '/agent/credential/self-attested', token, body);
  }

  verifyCredential(
    adminEndpoint: string,
    token: string,
    credential: Record<string, unknown>
  ): Promise<{ isValid?: boolean }> {
    return this.request('post', adminEndpoint, '/agent/credential/verify', token, { credential });
  }

  createConnectionInvitation(
    adminEndpoint: string,
    token: string,
    body: { multiUseInvitation: boolean; autoAcceptConnection: boolean; label: string; imageUrl?: string }
  ): Promise<ICreatedInvitation> {
    return this.request('post', adminEndpoint, '/didcomm/oob/create-invitation', token, body);
  }
}
