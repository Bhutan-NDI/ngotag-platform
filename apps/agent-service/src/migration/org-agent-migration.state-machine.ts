import { ORG_AGENT_MIGRATION_FROZEN_STATUSES, OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';

export enum OrgAgentMigrationPhase {
  PREPARE = 'PREPARE',
  SCHEDULED = 'SCHEDULED',
  MOVE = 'MOVE',
  FIRST_48_HOURS = 'FIRST_48_HOURS',
  CHANGE_OF_ADDRESS = 'CHANGE_OF_ADDRESS',
  COMPLETE = 'COMPLETE',
  CANCELLED = 'CANCELLED',
  RESTORED = 'RESTORED'
}

// REHEARSED -> REHEARSED is a re-run of the rehearsal or a reschedule. CUTOVER has no way back: once the org row
// points at the dedicated agent a failure is fixed forward, never aborted (SAD E.7).
const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  [Status.CREATED]: [Status.REHEARSED, Status.FAILED],
  [Status.REHEARSED]: [Status.REHEARSED, Status.FROZEN, Status.FAILED],
  [Status.FROZEN]: [Status.EXPORTING, Status.FAILED],
  [Status.EXPORTING]: [Status.IMPORTING, Status.FAILED],
  [Status.IMPORTING]: [Status.VERIFYING, Status.FAILED],
  [Status.VERIFYING]: [Status.CUTOVER, Status.FAILED],
  [Status.CUTOVER]: [Status.STABILISING],
  [Status.STABILISING]: [Status.ROTATING, Status.DISASTER_RESTORED],
  [Status.ROTATING]: [Status.COMPLETED],
  [Status.COMPLETED]: [],
  [Status.FAILED]: [],
  [Status.DISASTER_RESTORED]: []
};

export const TERMINAL_STATUSES: readonly Status[] = [Status.COMPLETED, Status.FAILED, Status.DISASTER_RESTORED];

export const canTransition = (from: Status, to: Status): boolean => TRANSITIONS[from]?.includes(to) ?? false;

export const isTerminal = (status: Status): boolean => TERMINAL_STATUSES.includes(status);

export const isFrozen = (status: Status): boolean => ORG_AGENT_MIGRATION_FROZEN_STATUSES.includes(status);

// A migration can be aborted losslessly exactly while it can still move to FAILED.
export const isAbortable = (status: Status): boolean => canTransition(status, Status.FAILED);

export const phaseFor = (status: Status, scheduledFor?: Date | null): OrgAgentMigrationPhase => {
  switch (status) {
    case Status.CREATED:
      return OrgAgentMigrationPhase.PREPARE;
    case Status.REHEARSED:
      return scheduledFor ? OrgAgentMigrationPhase.SCHEDULED : OrgAgentMigrationPhase.PREPARE;
    case Status.FROZEN:
    case Status.EXPORTING:
    case Status.IMPORTING:
    case Status.VERIFYING:
    case Status.CUTOVER:
      return OrgAgentMigrationPhase.MOVE;
    case Status.STABILISING:
      return OrgAgentMigrationPhase.FIRST_48_HOURS;
    case Status.ROTATING:
      return OrgAgentMigrationPhase.CHANGE_OF_ADDRESS;
    case Status.COMPLETED:
      return OrgAgentMigrationPhase.COMPLETE;
    case Status.FAILED:
      return OrgAgentMigrationPhase.CANCELLED;
    case Status.DISASTER_RESTORED:
      return OrgAgentMigrationPhase.RESTORED;
    default:
      throw new Error(`Unknown migration status: ${String(status)}`);
  }
};
