import {
  ORG_AGENT_MIGRATION_FROZEN_STATUSES,
  ORG_AGENT_MIGRATION_TERMINAL_STATUSES,
  OrgAgentMigrationStatus as Status
} from '@credebl/enum/enum';

// REHEARSED -> REHEARSED is a re-run of the rehearsal, SCHEDULED -> SCHEDULED a reschedule. SCHEDULED -> REHEARSED (a slot
// the scheduler gave up on) is not here: only `unschedule` takes it, with the slot the scheduler read, so a rehearsal that
// finishes on a booked row cannot. CANCELLED is the owner's choice and FAILED an automatic abort. CUTOVER has no way back: once the org row points at the dedicated agent a
// failure is fixed forward, never aborted (SAD E.7).
const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  [Status.CREATED]: [Status.REHEARSED, Status.CANCELLED],
  [Status.REHEARSED]: [Status.REHEARSED, Status.SCHEDULED, Status.CANCELLED],
  [Status.SCHEDULED]: [Status.SCHEDULED, Status.FROZEN, Status.CANCELLED, Status.FAILED],
  [Status.FROZEN]: [Status.EXPORTING, Status.FAILED],
  [Status.EXPORTING]: [Status.IMPORTING, Status.FAILED],
  [Status.IMPORTING]: [Status.VERIFYING, Status.FAILED],
  [Status.VERIFYING]: [Status.CUTOVER, Status.FAILED],
  [Status.CUTOVER]: [Status.STABILISING],
  [Status.STABILISING]: [Status.ROTATING, Status.DISASTER_RESTORED],
  [Status.ROTATING]: [Status.COMPLETED],
  [Status.COMPLETED]: [],
  [Status.FAILED]: [],
  [Status.CANCELLED]: [],
  [Status.DISASTER_RESTORED]: []
};

export const TERMINAL_STATUSES = ORG_AGENT_MIGRATION_TERMINAL_STATUSES;

export const canTransition = (from: Status, to: Status): boolean => TRANSITIONS[from]?.includes(to) ?? false;

export const isTerminal = (status: Status): boolean => TERMINAL_STATUSES.includes(status);

export const isFrozen = (status: Status): boolean => ORG_AGENT_MIGRATION_FROZEN_STATUSES.includes(status);

// A migration can be aborted losslessly exactly while it can still move to FAILED.
export const isAbortable = (status: Status): boolean => canTransition(status, Status.FAILED);
