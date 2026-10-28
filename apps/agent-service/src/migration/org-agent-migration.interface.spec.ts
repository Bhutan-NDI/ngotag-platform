import { Prisma } from '@prisma/client';
import { PUBLIC_MIGRATION_FIELDS, toPublicMigration } from './org-agent-migration.interface';

// Every column not meant for callers. A new column must be added here or to PUBLIC_MIGRATION_FIELDS.
const INTERNAL_FIELDS = [
  'sourceOrgAgentSnapshot',
  'tenantId',
  'newInvitationDid',
  'legacyInvitationDid',
  'exportJobId',
  'importJobId',
  'rotationJobId',
  'checksum',
  'importKeyFingerprint',
  'targetTokenEncrypted',
  'leaseUntil',
  'webhookProbeHash',
  'webhookProbeExpiresAt',
  'webhookCheckedAt'
];

const fullRow = (): Record<string, string> => {
  const entries = Object.keys(Prisma.Org_agent_migrationsScalarFieldEnum).map((field) => [field, `${field}-value`]);
  return Object.fromEntries(entries);
};

describe('toPublicMigration', () => {
  it('decides, for every column of the table, whether callers may read it', () => {
    const columns = Object.keys(Prisma.Org_agent_migrationsScalarFieldEnum).sort();

    expect([...PUBLIC_MIGRATION_FIELDS, ...INTERNAL_FIELDS].sort()).toEqual(columns);
  });

  it('returns the public fields and nothing else', () => {
    const result = toPublicMigration(fullRow() as never);

    expect(Object.keys(result).sort()).toEqual([...PUBLIC_MIGRATION_FIELDS].sort());
    for (const field of INTERNAL_FIELDS) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it('carries the values of the public fields through unchanged', () => {
    const result = toPublicMigration(fullRow() as never);

    expect(result).toMatchObject({ id: 'id-value', status: 'status-value', rotation: 'rotation-value' });
  });

  it('keeps no secret, address or identifier of the shared agent in the JSON a member receives', () => {
    const json = JSON.stringify(toPublicMigration(fullRow() as never));

    expect(json).not.toMatch(/targetTokenEncrypted|sourceOrgAgentSnapshot|tenantId|checksum|importKeyFingerprint/);
  });
});
