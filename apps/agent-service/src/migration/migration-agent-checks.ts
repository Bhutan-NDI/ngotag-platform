import { IAgentInfo, IAgentRuntimeConfig } from './migration-agent.client';
import { IPreflightCheck } from './org-agent-migration.interface';

export type AgentCheck = Omit<IPreflightCheck, 'id'>;

export const pass = (detail?: IPreflightCheck['detail']): AgentCheck => ({
  status: 'PASS',
  ...(detail ? { detail } : {})
});

export const fail = (code: string, detail?: IPreflightCheck['detail']): AgentCheck => ({
  status: 'FAIL',
  code,
  ...(detail ? { detail } : {})
});

export const sameAddress = (a: string, b: string): boolean => {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
};

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((value) => b.includes(value));

/**
 * The agent settings the move depends on (SAD 5.3): the dedicated agent answers like the shared one, takes DIDComm
 * over http only, can send over http and ws, runs the cron purge, and is not multi-tenant. Returns what differs, or nothing.
 */
export const configMismatches = (shared: IAgentRuntimeConfig, dedicated: IAgentRuntimeConfig): string[] => {
  const differences: string[] = [];
  if (shared.autoAcceptConnections !== dedicated.autoAcceptConnections) {
    differences.push('autoAcceptConnections');
  }
  if (shared.autoAcceptCredentials !== dedicated.autoAcceptCredentials) {
    differences.push('autoAcceptCredentials');
  }
  if (shared.autoAcceptProofs !== dedicated.autoAcceptProofs) {
    differences.push('autoAcceptProofs');
  }
  if (!sameSet(dedicated.inboundTransports, ['http'])) {
    differences.push('inboundTransports');
  }
  if (!['http', 'ws'].every((transport) => dedicated.outboundTransports.includes(transport))) {
    differences.push('outboundTransports');
  }
  if (!dedicated.cronPurgeEnabled) {
    differences.push('cronPurgeEnabled');
  }
  // Only an agent that says it is not multi-tenant qualifies: the wallet is imported into its root profile.
  if (false !== dedicated.tenancy) {
    differences.push('tenancy');
  }
  return differences;
};

/** The dedicated agent must report the DIDComm address the owner entered, as its first endpoint. */
export const checkEndpoint = (dedicated: IAgentInfo, entered: string): AgentCheck => {
  const endpoints = dedicated.endpoints ?? [];
  return endpoints[0] && sameAddress(endpoints[0], entered)
    ? pass()
    : fail('ENDPOINT_MISMATCH', { reported: endpoints });
};

export const checkRelease = (dedicated: IAgentInfo, shared?: IAgentInfo): AgentCheck => {
  if (!shared) {
    return fail('SHARED_AGENT_UNAVAILABLE');
  }
  if (!dedicated.releaseVersion || dedicated.releaseVersion !== shared.releaseVersion) {
    return fail('RELEASE_MISMATCH', {
      found: dedicated.releaseVersion ?? 'unknown',
      required: shared.releaseVersion ?? 'unknown'
    });
  }
  if (dedicated.storageVersion !== shared.storageVersion) {
    return fail('STORAGE_VERSION_MISMATCH', {
      found: dedicated.storageVersion ?? 'unknown',
      required: shared.storageVersion ?? 'unknown'
    });
  }
  return pass({ release: dedicated.releaseVersion });
};

export const checkConfig = (dedicated: IAgentInfo, shared?: IAgentInfo): AgentCheck => {
  if (!shared) {
    return fail('SHARED_AGENT_UNAVAILABLE');
  }
  if (!dedicated.config || !shared.config) {
    return fail('CONFIG_UNAVAILABLE');
  }
  const differences = configMismatches(shared.config, dedicated.config);
  return 0 === differences.length ? pass() : fail('CONFIG_MISMATCH', { settings: differences });
};
