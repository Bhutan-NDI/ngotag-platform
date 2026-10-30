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
  // True on the shared, multi-tenant agent. Absent on an agent too old to report it.
  tenancy?: boolean;
}

export interface IWebhookProbe {
  configured: boolean;
  delivered: boolean;
  status?: number;
}

export interface IExportBucketProbe {
  configured: boolean;
  reachable?: boolean;
  reason?: string;
}

export interface IPushImport {
  /** Where the platform fetches the sealed export from: the export job's presigned URL */
  downloadUrl: string;
  sessionId: string;
  checksum: string;
  sealedStoreKey: string;
  storageVersion: string;
  dryRun?: boolean;
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

export interface IRotationCounts {
  total: number;
  pending: number;
  retrying: number;
  failed: number;
  waiting: number;
  stale: number;
  refused: number;
  updated: number;
}

export interface IRotationStatus {
  job: { status: 'idle' | 'running' | 'completed'; startedAt?: string; completedAt?: string };
  counts: IRotationCounts;
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
export const RESTORE_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_PUSH_TIMEOUT_MS = 30 * 60 * 1000;

// A large wallet over a slow link takes far longer than an ordinary call.
const pushTimeoutMs = (): number => {
  const configured = Number(process.env.ORG_MIGRATION_PUSH_TIMEOUT_MS);
  return Number.isFinite(configured) && 0 < configured ? configured : DEFAULT_PUSH_TIMEOUT_MS;
};

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
      throw this.toAgentError(error);
    }
  }

  // Only the status and the agent's own message survive: the axios error also holds the request and its headers.
  private toAgentError(error): MigrationAgentError {
    const status: number | undefined = error?.response?.status;
    if (undefined === status) {
      return new MigrationAgentError('UNREACHABLE');
    }
    if (401 === status || 403 === status) {
      return new MigrationAgentError('REJECTED', status);
    }
    if (404 === status) {
      return new MigrationAgentError('NOT_FOUND', status);
    }
    const message = error.response?.data?.message;
    return new MigrationAgentError(
      409 === status ? 'CONFLICT' : 'FAILED',
      status,
      'string' === typeof message ? message : undefined
    );
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

  // Whether the agent could pull an export from its S3 bucket, or the platform has to send it.
  getExportBucket(adminEndpoint: string, token: string): Promise<IExportBucketProbe> {
    return this.request('get', adminEndpoint, '/agent/wallet/export-bucket', token);
  }

  /**
   * Import for an agent that cannot reach S3: the platform fetches the sealed export itself and streams it into the
   * agent's upload route, so the file is never held in memory. A failed download reports DOWNLOAD_FAILED and carries
   * nothing of the request, whose URL is signed.
   */
  async pushImport(
    adminEndpoint: string,
    token: string,
    input: IPushImport,
    // What is left of the freeze budget: the transfer is not allowed to outlast it.
    budgetMs: number = Infinity
  ): Promise<IPortabilityJob> {
    if (!/^https:\/\//i.test(input.downloadUrl)) {
      throw new MigrationAgentError('FAILED', undefined, 'DOWNLOAD_FAILED');
    }
    const timeout = Math.max(Math.min(pushTimeoutMs(), budgetMs), 1000);

    let artifact;
    try {
      artifact = await firstValueFrom(
        this.httpService.get(input.downloadUrl, {
          responseType: 'stream',
          timeout,
          maxRedirects: 0,
          validateStatus: (status) => 200 === status
        })
      );
    } catch (error) {
      // A refused download leaves its body unread; free the socket instead of holding it until the idle timeout.
      error?.response?.data?.destroy?.();
      throw new MigrationAgentError('FAILED', undefined, 'DOWNLOAD_FAILED');
    }

    // A stream that breaks part way surfaces as a failed upload; this keeps it reported as the download that failed.
    let downloadFailed = false;
    artifact.data?.on?.('error', () => {
      downloadFailed = true;
    });
    const length = artifact.headers?.['content-length'];
    try {
      const response = await firstValueFrom(
        this.httpService.post<IPortabilityJob>(
          `${trimSlash(adminEndpoint)}/agent/wallet/import/upload`,
          artifact.data,
          {
            headers: {
              authorization: token,
              accept: 'application/json',
              'content-type': 'application/octet-stream',
              'x-session-id': input.sessionId,
              'x-checksum': input.checksum,
              'x-sealed-store-key': input.sealedStoreKey,
              'x-storage-version': input.storageVersion,
              ...(input.dryRun ? { 'x-dry-run': 'true' } : {}),
              ...(length ? { 'content-length': length } : {})
            },
            timeout,
            // Following redirects would make axios keep the whole body in memory to replay it.
            maxRedirects: 0,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          }
        )
      );
      return response.data;
    } catch (error) {
      artifact.data?.destroy?.();
      if (downloadFailed) {
        throw new MigrationAgentError('FAILED', undefined, 'DOWNLOAD_FAILED');
      }
      throw this.toAgentError(error);
    }
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

  // The agent posts a test event to its own webhook URL; the platform decides whether it arrived.
  probeWebhook(adminEndpoint: string, token: string, probeId: string): Promise<IWebhookProbe> {
    return this.request('post', adminEndpoint, '/agent/webhook/probe', token, { probeId });
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

  // Takes the relay off for good, even a forwarding one: queued messages go back to the tenant first.
  // The agent hands every queued message back before it answers, and hours of traffic may be waiting.
  restoreRelay(sharedEndpoint: string, token: string, tenantId: string): Promise<{ injected: number; failed: number }> {
    return this.request(
      'post',
      sharedEndpoint,
      `/multi-tenancy/relay/${encodeURIComponent(tenantId)}/restore`,
      token,
      {},
      envMs('ORG_MIGRATION_RESTORE_TIMEOUT_MS', RESTORE_TIMEOUT_MS)
    );
  }

  getRelay(sharedEndpoint: string, token: string, tenantId: string): Promise<IRelayEntry> {
    return this.request('get', sharedEndpoint, `/multi-tenancy/relay/${encodeURIComponent(tenantId)}`, token);
  }

  purgeProfile(sharedEndpoint: string, token: string, tenantId: string): Promise<{ profileRemoved: boolean }> {
    return this.request(
      'post',
      sharedEndpoint,
      `/multi-tenancy/${encodeURIComponent(tenantId)}/purge-profile`,
      token,
      {}
    );
  }

  // Starts the rotation of every connection, or returns the job if one is already running.
  startRotation(adminEndpoint: string, token: string): Promise<IRotationStatus> {
    return this.request('post', adminEndpoint, '/didcomm/connections/rotate-all', token, {});
  }

  getRotationStatus(adminEndpoint: string, token: string): Promise<IRotationStatus> {
    return this.request('get', adminEndpoint, '/didcomm/connections/rotate-all/status', token);
  }
}
