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

export interface IScheduleOrgAgentMigration {
  orgId: string;
  userId: string;
  confirmationName: string;
  // When to start. Left out, the move starts at once.
  scheduledFor?: string | Date;
}

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
  downloadMethod?: 'PULL';
  exportMs?: number;
  importMs?: number;
  exportCleanup?: 'DELETED' | 'FAILED';
  finishedAt?: string;
}

export type IOrgAgentMigration = Omit<org_agent_migrations, 'targetTokenEncrypted'>;

// The stored token is a credential and must never leave agent-service.
export const toPublicMigration = (migration: org_agent_migrations): IOrgAgentMigration => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { targetTokenEncrypted, ...rest } = migration;
  return rest;
};
