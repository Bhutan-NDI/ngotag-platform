/* eslint-disable camelcase */
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';
import { org_agent_migrations } from '@prisma/client';

export interface ICreateOrgAgentMigration {
  orgId: string;
  userId: string;
  targetAdminEndpoint: string;
  targetDidcommEndpoint: string;
  apiKey?: string;
  backupsConfirmed?: boolean;
}

export interface IListOrgAgentMigrations {
  orgId?: string;
  status?: OrgAgentMigrationStatus;
  pageNumber?: number;
  pageSize?: number;
}

export interface IPreflightOrgAgentMigration {
  orgId: string;
  userId: string;
  apiKey?: string;
  backupsConfirmed?: boolean;
}

export interface IRehearseOrgAgentMigration {
  orgId: string;
  userId: string;
}

export interface IRestoreOrgAgentMigration {
  orgId: string;
  userId: string;
}

export interface ICancelOrgAgentMigration {
  orgId: string;
  userId: string;
}

export interface IScheduleOrgAgentMigration {
  orgId: string;
  userId: string;
  confirmationName: string;
  // When to start. Left out, the move starts at once.
  scheduledFor?: string | Date;
}

// How the dedicated agent gets the sealed export: it pulls it from S3, or the platform pushes it.
export type DownloadMethod = 'PULL' | 'PUSH';

export enum PreflightCheckId {
  ORG_IS_SHARED = 'ORG_IS_SHARED',
  AGENT_REACHABLE = 'AGENT_REACHABLE',
  TOKEN_IS_ROOT = 'TOKEN_IS_ROOT',
  ENDPOINT_MATCHES = 'ENDPOINT_MATCHES',
  RELEASE_MATCHES = 'RELEASE_MATCHES',
  CONFIG_MATCHES = 'CONFIG_MATCHES',
  TARGET_PRISTINE = 'TARGET_PRISTINE',
  DIDCOMM_REACHABLE = 'DIDCOMM_REACHABLE',
  NO_BULK_JOB = 'NO_BULK_JOB',
  WEBHOOK_DELIVERS = 'WEBHOOK_DELIVERS',
  DOWNLOAD_METHOD = 'DOWNLOAD_METHOD',
  NO_OUT_OF_SCOPE_ARTEFACTS = 'NO_OUT_OF_SCOPE_ARTEFACTS',
  NO_WEBSOCKET_ENDPOINTS = 'NO_WEBSOCKET_ENDPOINTS',
  SHARED_REDIS = 'SHARED_REDIS',
  BACKUPS_CONFIRMED = 'BACKUPS_CONFIRMED'
}

export type PreflightCheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface IPreflightCheck {
  id: PreflightCheckId;
  status: PreflightCheckStatus;
  // A stable code the studio maps to a message, never raw error text.
  code?: string;
  // Non-secret facts that help the owner fix it, such as the version found and the one required.
  detail?: Record<string, string | number | boolean | string[]>;
}

export interface IPreflightReport {
  ranAt: string;
  passed: boolean;
  checks: IPreflightCheck[];
}

export interface IRehearsalRecord {
  step?: 'EXPORT' | 'IMPORT';
  code?: string;
  downloadMethod?: DownloadMethod;
  exportMs?: number;
  importMs?: number;
  exportCleanup?: 'DELETED' | 'FAILED';
  finishedAt?: string;
}

export interface IRotationProgress {
  job: { status: string; startedAt?: string; completedAt?: string };
  counts: Record<string, number>;
  polledAt: string;
}

// What an owner or platform admin may read. Everything else on the row (the shared agent's snapshot, tenant and job
// ids, the export checksum and key fingerprint, the lease, and the stored token) stays inside agent-service.
export const PUBLIC_MIGRATION_FIELDS = [
  'id',
  'createDateTime',
  'lastChangedDateTime',
  'orgId',
  'status',
  'startedBy',
  'targetAdminEndpoint',
  'targetDidcommEndpoint',
  'counts',
  'releaseVersion',
  'storageVersion',
  'rehearsalDurationMs',
  'predictedFreezeMs',
  'scheduledFor',
  'freezeDeadline',
  'stabilisationEndsAt',
  'purgedAt',
  'error',
  'backupsConfirmedAt',
  'preflight',
  'rehearsalStatus',
  'rehearsalStartedAt',
  'rehearsal',
  'rotation',
  'webhookConfirmedAt',
  'downloadMethod'
] as const;

export type IOrgAgentMigration = Pick<org_agent_migrations, (typeof PUBLIC_MIGRATION_FIELDS)[number]>;

export const toPublicMigration = (migration: org_agent_migrations): IOrgAgentMigration => {
  const entries = PUBLIC_MIGRATION_FIELDS.map((field) => [field, migration[field]]);
  return Object.fromEntries(entries) as IOrgAgentMigration;
};
