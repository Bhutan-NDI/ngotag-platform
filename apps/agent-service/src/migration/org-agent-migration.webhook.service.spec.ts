/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { createHash } from 'crypto';
import { MigrationAgentError } from './migration-agent.client';
import { hashProbeId, OrgAgentMigrationWebhookService } from './org-agent-migration.webhook.service';

const MIGRATION = { id: 'm1', orgId: 'org-1' } as never;
const AGENT = { endpoint: 'https://admin.org.example.com', token: 'root-token' };

const build = () => {
  const world = { row: { id: 'm1', webhookProbeHash: null as string | null } };
  const migrationRepository = {
    tryBeginWebhookProbe: jest.fn(async (_id: string, hash: string) => {
      world.row.webhookProbeHash = hash;
      return true;
    }),
    getById: jest.fn(async () => ({ ...world.row })),
    endWebhookProbe: jest.fn(async () => undefined),
    confirmWebhookProbe: jest.fn(async () => true)
  };
  // The platform end consuming the probe is what clears the stored hash.
  const agentClient = {
    probeWebhook: jest.fn(async () => {
      world.row.webhookProbeHash = null;
      return { configured: true, delivered: true, status: 200 };
    })
  };
  const service = new OrgAgentMigrationWebhookService(migrationRepository as never, agentClient as never);
  return { service, world, migrationRepository, agentClient };
};

describe('OrgAgentMigrationWebhookService.check', () => {
  it('is confirmed when the platform consumed the probe the agent posted', async () => {
    const { service } = build();

    await expect(service.check(MIGRATION, AGENT)).resolves.toEqual({ confirmed: true });
  });

  it('asks the agent to post a UUID, and stores only its hash', async () => {
    const { service, migrationRepository, agentClient } = build();

    await service.check(MIGRATION, AGENT);

    const [endpoint, token, probeId] = agentClient.probeWebhook.mock.calls[0] as unknown as string[];
    expect([endpoint, token]).toEqual([AGENT.endpoint, AGENT.token]);
    expect(probeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [, storedHash, expiresAt] = migrationRepository.tryBeginWebhookProbe.mock.calls[0] as unknown as [
      string,
      string,
      Date
    ];
    expect(storedHash).toBe(createHash('sha256').update(probeId).digest('hex'));
    expect(storedHash).not.toContain(probeId);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('uses a different probe id every time', async () => {
    const { service, agentClient } = build();

    await service.check(MIGRATION, AGENT);
    await service.check(MIGRATION, AGENT);

    const ids = agentClient.probeWebhook.mock.calls.map((call) => (call as unknown as string[])[2]);
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    ['the agent has no webhook URL', { configured: false, delivered: false }, 'WEBHOOK_NOT_CONFIGURED'],
    ['nothing answered the agent', { configured: true, delivered: false }, 'WEBHOOK_UNREACHABLE'],
    [
      'something answered but it was not the platform',
      { configured: true, delivered: true, status: 200 },
      'WEBHOOK_REJECTED'
    ],
    ['the platform refused it', { configured: true, delivered: true, status: 404 }, 'WEBHOOK_REJECTED']
  ])('says why when %s', async (_name, sent, code) => {
    const { service, world, agentClient } = build();
    agentClient.probeWebhook.mockImplementation(async () => sent as never);
    world.row.webhookProbeHash = 'still-there';

    await expect(service.check(MIGRATION, AGENT)).resolves.toEqual({ confirmed: false, code });
  });

  it("does not take the agent's word for it: a 200 it saw is not a confirmation", async () => {
    const { service, world, agentClient } = build();
    agentClient.probeWebhook.mockImplementation(async () => ({ configured: true, delivered: true, status: 200 }));
    world.row.webhookProbeHash = 'not-consumed';

    const result = await service.check(MIGRATION, AGENT);

    expect(result.confirmed).toBe(false);
  });

  it('does not start a second probe while one is out', async () => {
    const { service, migrationRepository, agentClient } = build();
    migrationRepository.tryBeginWebhookProbe.mockResolvedValue(false);

    await expect(service.check(MIGRATION, AGENT)).resolves.toEqual({ confirmed: false, code: 'WEBHOOK_CHECK_BUSY' });
    expect(agentClient.probeWebhook).not.toHaveBeenCalled();
    expect(migrationRepository.endWebhookProbe).not.toHaveBeenCalled();
  });

  it('reports an agent without the probe route as unsupported, and any other failure as the agent being unavailable', async () => {
    const { service, agentClient } = build();

    agentClient.probeWebhook.mockRejectedValue(new MigrationAgentError('NOT_FOUND', 404));
    await expect(service.check(MIGRATION, AGENT)).resolves.toEqual({
      confirmed: false,
      code: 'WEBHOOK_PROBE_UNSUPPORTED'
    });

    agentClient.probeWebhook.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));
    await expect(service.check(MIGRATION, AGENT)).resolves.toEqual({ confirmed: false, code: 'AGENT_UNAVAILABLE' });
  });

  it('always frees the probe it took, whatever happened', async () => {
    const { service, migrationRepository, agentClient } = build();
    agentClient.probeWebhook.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

    await service.check(MIGRATION, AGENT);

    const [id, hash] = migrationRepository.endWebhookProbe.mock.calls[0] as unknown as string[];
    expect(id).toBe('m1');
    expect(hash).toBe((migrationRepository.tryBeginWebhookProbe.mock.calls[0] as unknown as string[])[1]);
  });

  it('is not undone by a failure to free the probe', async () => {
    const { service, migrationRepository } = build();
    migrationRepository.endWebhookProbe.mockRejectedValue(new Error('db down'));

    await expect(service.check(MIGRATION, AGENT)).resolves.toEqual({ confirmed: true });
  });
});

describe('OrgAgentMigrationWebhookService.confirm', () => {
  it("looks up the probe by its hash for that organisation, and returns the repository's answer", async () => {
    const { service, migrationRepository } = build();

    await expect(service.confirm('org-1', 'probe-1')).resolves.toBe(true);
    expect(migrationRepository.confirmWebhookProbe).toHaveBeenCalledWith('org-1', hashProbeId('probe-1'));

    migrationRepository.confirmWebhookProbe.mockResolvedValue(false);
    await expect(service.confirm('org-2', 'other')).resolves.toBe(false);
  });
});
