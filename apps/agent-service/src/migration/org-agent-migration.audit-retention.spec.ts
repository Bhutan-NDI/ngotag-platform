import { readFileSync } from 'fs';
import { join } from 'path';

const schema = readFileSync(join(__dirname, '../../../../libs/prisma-service/prisma/schema.prisma'), 'utf8');

const modelBody = (name: string): string => {
  const start = schema.indexOf(`model ${name} {`);
  return schema.slice(start, schema.indexOf('\n}', start));
};

describe('retention of the org agent migration audit trail (SAD §5.2: permanent)', () => {
  it.each(['org_agent_migrations', 'org_agent_migration_events'])(
    'has no cascading delete on %s, so removing a row elsewhere cannot remove audit entries',
    (model) => {
      expect(modelBody(model)).not.toMatch(/onDelete:\s*(Cascade|SetNull|SetDefault)/);
    }
  );

  it('does not tie the migration history to the organisation row, so it outlives the organisation', () => {
    expect(modelBody('org_agent_migrations')).not.toMatch(/@relation\(fields: \[orgId\]/);
    expect(modelBody('organisation')).not.toMatch(/org_agent_migrations/);
  });

  it('keeps an event from being deleted along with its migration', () => {
    expect(modelBody('org_agent_migration_events')).toMatch(/onDelete:\s*Restrict/);
  });
});
