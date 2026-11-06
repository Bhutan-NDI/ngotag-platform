/**
 * Note this repo has no jest step in CI - run with:
 *   npx jest apps/agent-service/src/migration/org-agent-migration.state-machine.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ORG_AGENT_MIGRATION_FROZEN_STATUSES, OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import {
  canTransition,
  isAbortable,
  isFrozen,
  isTerminal,
  TERMINAL_STATUSES
} from './org-agent-migration.state-machine';

const ALL = Object.values(Status);

const ALLOWED: [Status, Status][] = [
  [Status.CREATED, Status.REHEARSED],
  [Status.CREATED, Status.CANCELLED],
  [Status.REHEARSED, Status.REHEARSED],
  [Status.REHEARSED, Status.SCHEDULED],
  [Status.REHEARSED, Status.CANCELLED],
  [Status.SCHEDULED, Status.SCHEDULED],
  [Status.SCHEDULED, Status.FROZEN],
  [Status.SCHEDULED, Status.CANCELLED],
  [Status.SCHEDULED, Status.FAILED],
  [Status.FROZEN, Status.EXPORTING],
  [Status.FROZEN, Status.FAILED],
  [Status.EXPORTING, Status.IMPORTING],
  [Status.EXPORTING, Status.FAILED],
  [Status.IMPORTING, Status.VERIFYING],
  [Status.IMPORTING, Status.FAILED],
  [Status.VERIFYING, Status.CUTOVER],
  [Status.VERIFYING, Status.FAILED],
  [Status.CUTOVER, Status.STABILISING],
  [Status.STABILISING, Status.ROTATING],
  [Status.STABILISING, Status.DISASTER_RESTORED],
  [Status.ROTATING, Status.COMPLETED]
];

describe('org agent migration state machine', () => {
  it.each(ALLOWED)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('rejects every transition that is not listed', () => {
    const listed = new Set(ALLOWED.map(([from, to]) => `${from}>${to}`));
    for (const from of ALL) {
      for (const to of ALL) {
        if (!listed.has(`${from}>${to}`)) {
          expect([from, to, canTransition(from, to)]).toEqual([from, to, false]);
        }
      }
    }
  });

  it('walks the whole happy path from CREATED to COMPLETED', () => {
    const path = [
      Status.CREATED,
      Status.REHEARSED,
      Status.SCHEDULED,
      Status.FROZEN,
      Status.EXPORTING,
      Status.IMPORTING,
      Status.VERIFYING,
      Status.CUTOVER,
      Status.STABILISING,
      Status.ROTATING,
      Status.COMPLETED
    ];
    path.slice(1).forEach((to, index) => expect(canTransition(path[index], to)).toBe(true));
  });

  it('does not let a booked move go back to REHEARSED through advance, which only unschedule may do', () => {
    expect(canTransition(Status.SCHEDULED, Status.REHEARSED)).toBe(false);
  });

  it('cannot skip the rehearsal or the schedule', () => {
    expect(canTransition(Status.CREATED, Status.FROZEN)).toBe(false);
    expect(canTransition(Status.REHEARSED, Status.FROZEN)).toBe(false);
  });

  it('lets the owner cancel until the move starts, and only then', () => {
    const cancellable = ALL.filter((status) => canTransition(status, Status.CANCELLED));

    expect(cancellable).toEqual([Status.CREATED, Status.REHEARSED, Status.SCHEDULED]);
  });

  it('has no way out of a finished migration', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
      expect(ALL.some((to) => canTransition(status, to))).toBe(false);
      expect(isFrozen(status)).toBe(false);
    }
  });

  it('can abort exactly until the switch, and is frozen exactly from FROZEN to CUTOVER', () => {
    const abortable = ALL.filter(isAbortable);
    expect(abortable).toEqual([Status.SCHEDULED, Status.FROZEN, Status.EXPORTING, Status.IMPORTING, Status.VERIFYING]);
    expect(isAbortable(Status.CUTOVER)).toBe(false);
    expect(isAbortable(Status.STABILISING)).toBe(false);

    expect(ALL.filter(isFrozen)).toEqual([...ORG_AGENT_MIGRATION_FROZEN_STATUSES]);
    expect(isFrozen(Status.CUTOVER)).toBe(true);
    expect(isFrozen(Status.STABILISING)).toBe(false);
  });

  it('keeps the partial unique index in the migration SQL on the same terminal states', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../libs/prisma-service/prisma/migrations/20261028010000_org_agent_migrations_scheduled_cancelled/migration.sql'
      ),
      'utf8'
    );
    const match = sql.match(/WHERE "status" NOT IN \(([^)]*)\)/);
    const inIndex = (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/'/g, ''));

    expect([...inIndex].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });
});
