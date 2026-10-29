/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, prefer-destructuring */
import { BadRequestException, ConflictException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { MigrationAgentError } from './migration-agent.client';
import { PreflightCheckId as Check } from './org-agent-migration.interface';
import { configMismatches, OrgAgentMigrationPreflightService } from './org-agent-migration.preflight.service';
import { OrgAgentMigrationScheduler } from './org-agent-migration.scheduler';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const MIGRATION_ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';
const ROOT_TOKEN = jwt.sign({ role: 'RestRootAgent' }, 'test');
const SHARED_TOKEN = 'base-wallet-token';

const sharedConfig = {
  autoAcceptConnections: true,
  autoAcceptCredentials: 'always',
  autoAcceptProofs: 'contentApproved',
  inboundTransports: ['http'],
  outboundTransports: ['http', 'ws'],
  cronPurgeEnabled: true
};
const sharedInfo = {
  endpoints: ['https://shared.example.com'],
  isInitialized: true,
  releaseVersion: '2.1.3',
  storageVersion: '0.5',
  config: sharedConfig
};
const dedicatedInfo = { ...sharedInfo, endpoints: ['https://didcomm.org.example.com/'], config: { ...sharedConfig } };

const migrationRow = (overrides = {}) => ({
  id: MIGRATION_ID,
  orgId: ORG_ID,
  status: 'CREATED',
  tenantId: 'tenant-1',
  targetAdminEndpoint: 'https://admin.org.example.com',
  targetDidcommEndpoint: 'https://didcomm.org.example.com',
  targetTokenEncrypted: null,
  backupsConfirmedAt: null,
  ...overrides
});

const build = (options: { migration?: object; dedicated?: object; shared?: object } = {}) => {
  const migration = options.migration ?? migrationRow();
  const agentServiceRepository = {
    getAgentDetailsByOrgId: jest.fn().mockResolvedValue({ orgAgentTypeId: 'shared-type' }),
    getOrgAgentTypeDetails: jest.fn().mockResolvedValue('shared-type')
  };
  const migrationRepository = {
    getById: jest.fn().mockResolvedValue(migration),
    update: jest.fn().mockImplementation(async (_id, patch) => ({ ...migration, ...patch })),
    recordEvent: jest.fn().mockResolvedValue(undefined),
    hasActiveBulkIssuance: jest.fn().mockResolvedValue(false),
    countOutOfScopeArtefacts: jest.fn().mockResolvedValue({ oidcIssuers: 0, credentialDefinitions: 0 })
  };
  const agentClient = {
    createToken: jest.fn().mockResolvedValue(ROOT_TOKEN),
    getAgentInfo: jest
      .fn()
      .mockImplementation(async (endpoint: string) =>
        'https://admin.org.example.com' === endpoint
          ? (options.dedicated ?? dedicatedInfo)
          : (options.shared ?? sharedInfo)
      ),
    createImportSession: jest.fn().mockResolvedValue({ sessionId: 's', importPublicKey: 'k' }),
    probeRelayTarget: jest.fn().mockResolvedValue({ reachable: true, status: 404 }),
    getRelayHealth: jest.fn().mockResolvedValue({ enabled: true, redisReady: true }),
    getExportBucket: jest.fn().mockResolvedValue({ configured: true, reachable: true }),
    getEndpointSchemes: jest.fn().mockResolvedValue({ didsScanned: 3, schemes: [{ scheme: 'https', count: 3 }] })
  };
  const access = {
    shared: jest.fn().mockResolvedValue({ endpoint: 'https://shared.example.com', token: SHARED_TOKEN }),
    dedicated: jest.fn().mockResolvedValue(undefined),
    encryptToken: jest.fn().mockImplementation((token: string) => `enc(${token})`)
  };
  const webhookService = { check: jest.fn().mockResolvedValue({ confirmed: true }) };
  const logger = { error: jest.fn() };
  const service = new OrgAgentMigrationPreflightService(
    agentServiceRepository as never,
    migrationRepository as never,
    agentClient as never,
    access as never,
    webhookService as never,
    logger as never
  );
  return { service, agentServiceRepository, migrationRepository, agentClient, access, webhookService, logger };
};

const input = { apiKey: 'api-key', backupsConfirmed: true };
const checkOf = (report: { checks: { id: string; status: string }[] }, id: Check) =>
  report.checks.find((check) => check.id === id);

describe('OrgAgentMigrationPreflightService', () => {
  describe('how the agent gets the export', () => {
    const methodOf = (migrationRepository: { update: jest.Mock }) =>
      migrationRepository.update.mock.calls[0][1].downloadMethod;

    it('is PULL when the agent can reach its export bucket', async () => {
      const { service, migrationRepository } = build();

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({ status: 'PASS', detail: { method: 'PULL' } });
      expect(methodOf(migrationRepository)).toBe('PULL');
    });

    it.each([
      [{ configured: false }, 'BUCKET_NOT_CONFIGURED'],
      [{ configured: true, reachable: false, reason: 'DNS' }, 'DNS'],
      [{ configured: true, reachable: false }, 'UNREACHABLE']
    ])('is PUSH, and still a pass, when the agent reports %j', async (bucket, reason) => {
      const { service, migrationRepository, agentClient } = build();
      agentClient.getExportBucket.mockResolvedValue(bucket);

      const { report } = await service.run(MIGRATION_ID, input);

      expect(report.passed).toBe(true);
      expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({
        status: 'PASS',
        detail: { method: 'PUSH', reason }
      });
      expect(methodOf(migrationRepository)).toBe('PUSH');
    });

    describe('in the final check before the freeze, with the method locked', () => {
      const locked = { ...input, keepDownloadMethod: true };
      const rehearsedAs = (method: 'PULL' | 'PUSH', stored: 'PULL' | 'PUSH' | null = method) => ({
        migration: migrationRow({ downloadMethod: stored, rehearsal: { downloadMethod: method } })
      });

      it('keeps a rehearsed PULL while the agent can still reach its bucket', async () => {
        const { service, migrationRepository } = build(rehearsedAs('PULL'));

        const { report } = await service.run(MIGRATION_ID, locked);

        expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({ status: 'PASS', detail: { method: 'PULL' } });
        expect(methodOf(migrationRepository)).toBe('PULL');
      });

      it('does not switch a rehearsed PULL to PUSH over one failed probe: the check fails instead', async () => {
        const { service, migrationRepository, agentClient } = build(rehearsedAs('PULL'));
        agentClient.getExportBucket.mockResolvedValue({ configured: true, reachable: false, reason: 'TIMEOUT' });

        const { report } = await service.run(MIGRATION_ID, locked);

        expect(report.passed).toBe(false);
        expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({
          status: 'FAIL',
          code: 'DOWNLOAD_METHOD_CHANGED',
          detail: { rehearsed: 'PULL', reason: 'TIMEOUT' }
        });
        expect(methodOf(migrationRepository)).toBe('PULL');
      });

      it('keeps a rehearsed PUSH even when the agent can now reach its bucket', async () => {
        const { service, migrationRepository } = build(rehearsedAs('PUSH'));

        const { report } = await service.run(MIGRATION_ID, locked);

        expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({ status: 'PASS', detail: { method: 'PUSH' } });
        expect(methodOf(migrationRepository)).toBe('PUSH');
      });

      it('locks to the method the rehearsal ran, not the one a later preflight stored', async () => {
        const { service, migrationRepository, agentClient } = build(rehearsedAs('PULL', 'PUSH'));
        agentClient.getExportBucket.mockResolvedValue({ configured: true, reachable: false, reason: 'TIMEOUT' });

        const { report } = await service.run(MIGRATION_ID, locked);

        expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({
          status: 'FAIL',
          code: 'DOWNLOAD_METHOD_CHANGED'
        });
        expect(methodOf(migrationRepository)).toBe('PULL');
      });

      it('treats a rehearsal with no recorded method as PULL, and does not turn it into PUSH on one failed probe', async () => {
        const { service, agentClient } = build({ migration: migrationRow({ downloadMethod: null, rehearsal: {} }) });
        agentClient.getExportBucket.mockResolvedValue({ configured: true, reachable: false, reason: 'TIMEOUT' });

        const { report } = await service.run(MIGRATION_ID, locked);

        expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({
          status: 'FAIL',
          code: 'DOWNLOAD_METHOD_CHANGED'
        });
      });
    });

    it('leaves the method as it was when the agent cannot be asked', async () => {
      const { service, migrationRepository, agentClient } = build();
      agentClient.getExportBucket.mockRejectedValue(new MigrationAgentError('NOT_FOUND', 404));

      const { report } = await service.run(MIGRATION_ID, input);

      expect(report.passed).toBe(true);
      expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({
        status: 'PASS',
        detail: { method: 'PULL', reason: 'PROBE_UNAVAILABLE' }
      });
      expect(migrationRepository.update.mock.calls[0][1]).not.toHaveProperty('downloadMethod');
    });

    it.each(['PULL', 'PUSH'] as const)(
      'keeps the rehearsed %s when the final check cannot ask the agent, and still passes',
      async (method) => {
        const { service, migrationRepository, agentClient } = build({
          migration: migrationRow({ downloadMethod: method, rehearsal: { downloadMethod: method } })
        });
        agentClient.getExportBucket.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

        const { report } = await service.run(MIGRATION_ID, { ...input, keepDownloadMethod: true });

        expect(report.passed).toBe(true);
        expect(checkOf(report, Check.DOWNLOAD_METHOD)).toMatchObject({
          status: 'PASS',
          detail: { method, reason: 'PROBE_UNAVAILABLE' }
        });
        expect(migrationRepository.update.mock.calls[0][1].downloadMethod).toBe(method);
      }
    );

    it('is skipped when the agent could not be reached at all', async () => {
      const { service, agentClient } = build();
      agentClient.getAgentInfo.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

      await service.run(MIGRATION_ID, input);

      expect(agentClient.getExportBucket).not.toHaveBeenCalled();
    });
  });

  describe('the webhook check', () => {
    it('has the dedicated agent send a test event to the platform, using the stored admin address and token', async () => {
      const { service, webhookService } = build();

      await service.run(MIGRATION_ID, input);

      expect(webhookService.check).toHaveBeenCalledWith(expect.objectContaining({ id: MIGRATION_ID }), {
        endpoint: 'https://admin.org.example.com',
        token: ROOT_TOKEN
      });
    });

    it.each(['WEBHOOK_NOT_CONFIGURED', 'WEBHOOK_UNREACHABLE', 'WEBHOOK_REJECTED', 'WEBHOOK_PROBE_UNSUPPORTED'])(
      'fails with %s when the event does not arrive',
      async (code) => {
        const { service, webhookService } = build();
        webhookService.check.mockResolvedValue({ confirmed: false, code });

        const { report } = await service.run(MIGRATION_ID, input);

        expect(report.passed).toBe(false);
        expect(checkOf(report, Check.WEBHOOK_DELIVERS)).toMatchObject({ status: 'FAIL', code });
      }
    );

    it('is skipped when the agent could not be reached, since there is nothing to send the event', async () => {
      const { service, webhookService, agentClient } = build();
      agentClient.getAgentInfo.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

      const { report } = await service.run(MIGRATION_ID, input);

      expect(webhookService.check).not.toHaveBeenCalled();
      expect(checkOf(report, Check.WEBHOOK_DELIVERS)).toMatchObject({ status: 'SKIPPED' });
    });
  });

  it('passes every check for a correctly set up agent and stores the report, the token and the confirmation', async () => {
    const { service, migrationRepository, agentClient } = build();

    const { report } = await service.run(MIGRATION_ID, input);

    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(Object.values(Check).length);
    expect(report.checks.every((check) => 'PASS' === check.status)).toBe(true);
    expect(agentClient.createToken).toHaveBeenCalledWith('https://admin.org.example.com', 'api-key');
    const [, patch] = migrationRepository.update.mock.calls[0];
    expect(patch).toMatchObject({
      targetTokenEncrypted: `enc(${ROOT_TOKEN})`,
      releaseVersion: '2.1.3',
      storageVersion: '0.5',
      preflight: report
    });
    expect(patch.backupsConfirmedAt).toBeInstanceOf(Date);
  });

  it('never puts the API key or a token on the stored report', async () => {
    const { service } = build();

    const { report } = await service.run(MIGRATION_ID, input);

    expect(JSON.stringify(report)).not.toMatch(/api-key|base-wallet-token/);
    expect(JSON.stringify(report)).not.toContain(ROOT_TOKEN);
  });

  it('probes the public DIDComm address through the shared agent for the org tenant', async () => {
    const { service, agentClient } = build();

    await service.run(MIGRATION_ID, input);

    expect(agentClient.probeRelayTarget).toHaveBeenCalledWith(
      'https://shared.example.com',
      SHARED_TOKEN,
      'tenant-1',
      'https://didcomm.org.example.com'
    );
  });

  it('reuses the stored token when no API key is given, and does not store a new one', async () => {
    const { service, access, agentClient, migrationRepository } = build({
      migration: migrationRow({ targetTokenEncrypted: 'stored', backupsConfirmedAt: new Date() })
    });
    access.dedicated.mockResolvedValue({ endpoint: 'https://admin.org.example.com', token: ROOT_TOKEN });

    const { report } = await service.run(MIGRATION_ID, {});

    expect(report.passed).toBe(true);
    expect(agentClient.createToken).not.toHaveBeenCalled();
    expect(migrationRepository.update.mock.calls[0][1]).not.toHaveProperty('targetTokenEncrypted');
  });

  it('keeps an earlier backups confirmation on a re-run that does not repeat it', async () => {
    const confirmedAt = new Date('2026-10-19T00:00:00Z');
    const { service, migrationRepository } = build({ migration: migrationRow({ backupsConfirmedAt: confirmedAt }) });

    const { report } = await service.run(MIGRATION_ID, { apiKey: 'api-key' });

    expect(checkOf(report, Check.BACKUPS_CONFIRMED)?.status).toBe('PASS');
    expect(migrationRepository.update.mock.calls[0][1].backupsConfirmedAt).toBe(confirmedAt);
  });

  describe('audit', () => {
    it('records who ran the checks and which failed, without any result detail', async () => {
      const { service, migrationRepository } = build();

      await service.run(MIGRATION_ID, { apiKey: 'api-key' }, 'user-1');

      expect(migrationRepository.recordEvent).toHaveBeenCalledWith(MIGRATION_ID, {
        action: 'PREFLIGHT_RUN',
        actor: 'user-1',
        detail: { passed: false, failed: [Check.BACKUPS_CONFIRMED] }
      });
    });

    it('records a clean run as passed', async () => {
      const { service, migrationRepository } = build();

      await service.run(MIGRATION_ID, input, 'user-1');

      expect(migrationRepository.recordEvent.mock.calls[0][1].detail).toEqual({ passed: true, failed: [] });
    });

    it('still returns the report when the audit write fails', async () => {
      const { service, migrationRepository, logger } = build();
      migrationRepository.recordEvent.mockRejectedValue(new Error('db down'));

      await expect(service.run(MIGRATION_ID, input, 'user-1')).resolves.toMatchObject({ report: { passed: true } });
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('fails the backups check and nothing else when the owner has not confirmed backups', async () => {
      const { service } = build();

      const { report } = await service.run(MIGRATION_ID, { apiKey: 'api-key' });

      expect(report.passed).toBe(false);
      expect(report.checks.filter((check) => 'FAIL' === check.status).map((check) => check.id)).toEqual([
        Check.BACKUPS_CONFIRMED
      ]);
      expect(checkOf(report, Check.BACKUPS_CONFIRMED)).toMatchObject({ code: 'BACKUPS_NOT_CONFIRMED' });
    });

    it('fails when the org is not on the shared agent', async () => {
      const { service, agentServiceRepository } = build();
      agentServiceRepository.getAgentDetailsByOrgId.mockResolvedValue({ orgAgentTypeId: 'dedicated-type' });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.ORG_IS_SHARED)).toMatchObject({ status: 'FAIL', code: 'ORG_NOT_SHARED' });
    });

    it('reports an unreachable admin address and skips the checks that need the agent', async () => {
      const { service, agentClient } = build();
      agentClient.createToken.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.AGENT_REACHABLE)).toMatchObject({ status: 'FAIL', code: 'AGENT_UNREACHABLE' });
      for (const id of [
        Check.TOKEN_IS_ROOT,
        Check.ENDPOINT_MATCHES,
        Check.RELEASE_MATCHES,
        Check.CONFIG_MATCHES,
        Check.TARGET_PRISTINE
      ]) {
        expect(checkOf(report, id)?.status).toBe('SKIPPED');
      }
      expect(checkOf(report, Check.NO_BULK_JOB)?.status).toBe('PASS');
    });

    it('tells a rejected API key from an unreachable agent', async () => {
      const { service, agentClient } = build();
      agentClient.createToken.mockRejectedValue(new MigrationAgentError('REJECTED', 401));

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.AGENT_REACHABLE)).toMatchObject({ code: 'AGENT_TOKEN_REJECTED' });
    });

    it('asks for the API key when there is no stored token and none is given', async () => {
      const { service } = build();

      const { report } = await service.run(MIGRATION_ID, { backupsConfirmed: true });

      expect(checkOf(report, Check.AGENT_REACHABLE)).toMatchObject({ code: 'API_KEY_REQUIRED' });
    });

    it('refuses a token that is not a root-agent token', async () => {
      const { service, agentClient } = build();
      agentClient.createToken.mockResolvedValue(jwt.sign({ role: 'RestRootAgentWithTenants' }, 'test'));

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.TOKEN_IS_ROOT)).toMatchObject({ status: 'FAIL', code: 'TOKEN_NOT_ROOT' });
    });

    it('does not keep a token that is not a root-agent token', async () => {
      const { service, agentClient, migrationRepository } = build();
      agentClient.createToken.mockResolvedValue(jwt.sign({ role: 'RestTenantAgent' }, 'test'));

      await service.run(MIGRATION_ID, input);

      expect(migrationRepository.update.mock.calls[0][1]).not.toHaveProperty('targetTokenEncrypted');
    });

    it('refuses an agent that reports a different DIDComm address', async () => {
      const { service } = build({ dedicated: { ...dedicatedInfo, endpoints: ['https://other.example.com'] } });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.ENDPOINT_MATCHES)).toMatchObject({
        status: 'FAIL',
        code: 'ENDPOINT_MISMATCH',
        detail: { reported: ['https://other.example.com'] }
      });
    });

    it('accepts the same address written with a trailing slash', async () => {
      const { service } = build({ dedicated: { ...dedicatedInfo, endpoints: ['https://didcomm.org.example.com/'] } });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.ENDPOINT_MATCHES)?.status).toBe('PASS');
    });

    it('names the version found and the one required when the release differs', async () => {
      const { service } = build({ dedicated: { ...dedicatedInfo, releaseVersion: '2.0.0' } });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.RELEASE_MATCHES)).toMatchObject({
        status: 'FAIL',
        code: 'RELEASE_MISMATCH',
        detail: { found: '2.0.0', required: '2.1.3' }
      });
    });

    it('fails an agent that does not report a release at all', async () => {
      const { service } = build({ dedicated: { ...dedicatedInfo, releaseVersion: undefined } });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.RELEASE_MATCHES)).toMatchObject({ status: 'FAIL', code: 'RELEASE_MISMATCH' });
    });

    it('fails when the storage version differs even though the release matches', async () => {
      const { service } = build({ dedicated: { ...dedicatedInfo, storageVersion: '0.4' } });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.RELEASE_MATCHES)).toMatchObject({ code: 'STORAGE_VERSION_MISMATCH' });
    });

    it('lists the settings that differ from the required configuration', async () => {
      const { service } = build({
        dedicated: {
          ...dedicatedInfo,
          config: { ...sharedConfig, autoAcceptProofs: 'never', cronPurgeEnabled: false }
        }
      });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.CONFIG_MATCHES)).toMatchObject({
        status: 'FAIL',
        code: 'CONFIG_MISMATCH',
        detail: { settings: ['autoAcceptProofs', 'cronPurgeEnabled'] }
      });
    });

    it('fails an agent that is too old to report its configuration', async () => {
      const { service } = build({ dedicated: { ...dedicatedInfo, config: undefined } });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.CONFIG_MATCHES)).toMatchObject({ code: 'CONFIG_UNAVAILABLE' });
    });

    it('fails when the target wallet already holds data', async () => {
      const { service, agentClient } = build();
      agentClient.createImportSession.mockRejectedValue(
        new MigrationAgentError('CONFLICT', 409, 'TARGET_NOT_PRISTINE')
      );

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.TARGET_PRISTINE)).toMatchObject({ status: 'FAIL', code: 'TARGET_NOT_PRISTINE' });
    });

    it('fails when citizens could not reach the DIDComm address', async () => {
      const { service, agentClient } = build();
      agentClient.probeRelayTarget.mockResolvedValue({ reachable: false, reason: 'TLS' });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.DIDCOMM_REACHABLE)).toMatchObject({
        status: 'FAIL',
        code: 'DIDCOMM_UNREACHABLE',
        detail: { reason: 'TLS' }
      });
    });

    it.each([502, 503])(
      'fails when the DIDComm address answers %s, since nothing healthy is behind it',
      async (status) => {
        const { service, agentClient } = build();
        agentClient.probeRelayTarget.mockResolvedValue({ reachable: true, status });

        const { report } = await service.run(MIGRATION_ID, input);

        expect(checkOf(report, Check.DIDCOMM_REACHABLE)).toMatchObject({
          status: 'FAIL',
          code: 'DIDCOMM_UNREACHABLE',
          detail: { reason: `HTTP_${status}` }
        });
      }
    );

    it.each([200, 404, 403])('passes when the DIDComm address answers %s', async (status) => {
      const { service, agentClient } = build();
      agentClient.probeRelayTarget.mockResolvedValue({ reachable: true, status });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.DIDCOMM_REACHABLE)).toMatchObject({ status: 'PASS' });
    });

    it.each([
      ['redis is not ready', () => Promise.resolve({ enabled: true, redisReady: false })],
      ['the relay is switched off', () => Promise.reject(new MigrationAgentError('CONFLICT', 409, 'RELAY_DISABLED'))]
    ])('requires shared Redis when %s', async (_name, health) => {
      const { service, agentClient } = build();
      agentClient.getRelayHealth.mockImplementation(health);

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.SHARED_REDIS)).toMatchObject({
        status: 'FAIL',
        code: 'RELAY_REQUIRES_SHARED_REDIS'
      });
    });

    it('blocks an org whose DIDs use websocket endpoints', async () => {
      const { service, agentClient } = build();
      agentClient.getEndpointSchemes.mockResolvedValue({
        didsScanned: 4,
        schemes: [
          { scheme: 'https', count: 3 },
          { scheme: 'wss', count: 1 }
        ]
      });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.NO_WEBSOCKET_ENDPOINTS)).toMatchObject({
        status: 'FAIL',
        code: 'RELAY_WS_UNSUPPORTED',
        detail: { schemes: ['wss'] }
      });
    });

    it('passes the websocket check but says how many DIDs it could not read', async () => {
      const { service, agentClient } = build();
      agentClient.getEndpointSchemes.mockResolvedValue({
        didsScanned: 4,
        unresolvedDids: 2,
        schemes: [{ scheme: 'https', count: 2 }]
      });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.NO_WEBSOCKET_ENDPOINTS)).toMatchObject({
        status: 'PASS',
        detail: { unresolvedDids: 2 }
      });
    });

    it('blocks an org with a bulk issuance still running', async () => {
      const { service, migrationRepository } = build();
      migrationRepository.hasActiveBulkIssuance.mockResolvedValue(true);

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.NO_BULK_JOB)).toMatchObject({ status: 'FAIL', code: 'ORG_BULK_JOB_ACTIVE' });
    });

    it('blocks an org that has OID4VC, x509, AnonCreds or status-list records, and says which', async () => {
      const { service, migrationRepository } = build();
      migrationRepository.countOutOfScopeArtefacts.mockResolvedValue({
        oidcIssuers: 2,
        x509Certificates: 0,
        credentialDefinitions: 1
      });

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.NO_OUT_OF_SCOPE_ARTEFACTS)).toMatchObject({
        status: 'FAIL',
        code: 'OUT_OF_SCOPE_ARTEFACTS',
        detail: { found: ['oidcIssuers', 'credentialDefinitions'] }
      });
    });

    it('fails the checks that need the shared agent, without throwing, when it cannot be reached', async () => {
      const { service, access } = build();
      access.shared.mockResolvedValue(undefined);

      const { report } = await service.run(MIGRATION_ID, input);

      for (const id of [
        Check.DIDCOMM_REACHABLE,
        Check.SHARED_REDIS,
        Check.NO_WEBSOCKET_ENDPOINTS,
        Check.RELEASE_MATCHES
      ]) {
        expect(checkOf(report, id)).toMatchObject({ status: 'FAIL', code: 'SHARED_AGENT_UNAVAILABLE' });
      }
    });

    it('records a failed database check as a failed check instead of throwing', async () => {
      const { service, migrationRepository } = build();
      migrationRepository.hasActiveBulkIssuance.mockRejectedValue(new Error('db down'));

      const { report } = await service.run(MIGRATION_ID, input);

      expect(checkOf(report, Check.NO_BULK_JOB)).toMatchObject({ status: 'FAIL', code: 'CHECK_FAILED' });
    });
  });

  it.each(['FROZEN', 'EXPORTING', 'CUTOVER', 'COMPLETED', 'FAILED', 'CANCELLED'])(
    'does not run on a migration in %s',
    async (status) => {
      const { service, migrationRepository } = build({ migration: migrationRow({ status }) });

      await expect(service.run(MIGRATION_ID, input)).rejects.toBeInstanceOf(BadRequestException);
      expect(migrationRepository.update).not.toHaveBeenCalled();
    }
  );

  it('runs on a scheduled migration, which is what the scheduler checks just before the move', async () => {
    const { service } = build({ migration: migrationRow({ status: 'SCHEDULED' }) });

    await expect(service.run(MIGRATION_ID, input)).resolves.toMatchObject({ report: { passed: true } });
  });

  it('lets the scheduler start a scheduled move, through the real status guard', async () => {
    const { service, access } = build({
      migration: migrationRow({ status: 'SCHEDULED', targetTokenEncrypted: 'stored', backupsConfirmedAt: new Date() })
    });
    access.dedicated.mockResolvedValue({ endpoint: 'https://admin.org.example.com', token: ROOT_TOKEN });
    const dueMove = {
      id: MIGRATION_ID,
      status: 'SCHEDULED',
      startedBy: 'owner-1',
      scheduledFor: new Date(Date.now() - 1000)
    };
    const migrationRepository = {
      findDueForStart: jest.fn().mockResolvedValue([dueMove]),
      findStalled: jest.fn().mockResolvedValue([]),
      countInFlight: jest.fn().mockResolvedValue(0),
      tryAcquireLease: jest.fn().mockResolvedValue(true),
      getConfirmingActor: jest.fn().mockResolvedValue('owner-1'),
      recordEvent: jest.fn().mockResolvedValue(undefined)
    };
    const executor = {
      run: jest.fn().mockResolvedValue(undefined),
      abortInterrupted: jest.fn(),
      resumeCutover: jest.fn()
    };
    const scheduler = new OrgAgentMigrationScheduler(
      { addInterval: jest.fn(), deleteInterval: jest.fn() } as never,
      migrationRepository as never,
      { abort: jest.fn() } as never,
      service,
      executor as never,
      {} as never,
      { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as never
    );

    await scheduler.tick();

    expect(executor.run).toHaveBeenCalledWith(MIGRATION_ID, 'owner-1');
  });

  it('writes its result only while the move is still open, so a cancel that overlapped it keeps the token off the row', async () => {
    const { service, migrationRepository } = build();

    await service.run(MIGRATION_ID, input);

    expect(migrationRepository.update.mock.calls[0][2]).toEqual(['CREATED', 'REHEARSED', 'SCHEDULED']);
  });

  it('gives up when the move was finished while the checks ran', async () => {
    const { service, migrationRepository } = build();
    migrationRepository.update.mockRejectedValue(new ConflictException('state changed'));

    await expect(service.run(MIGRATION_ID, input)).rejects.toBeInstanceOf(ConflictException);
  });

  it('runs again on a rehearsed migration', async () => {
    const { service } = build({ migration: migrationRow({ status: 'REHEARSED' }) });

    await expect(service.run(MIGRATION_ID, input)).resolves.toMatchObject({ report: { passed: true } });
  });
});

describe('configMismatches', () => {
  it('is empty for a matching configuration', () => {
    expect(configMismatches(sharedConfig, { ...sharedConfig })).toEqual([]);
  });

  it('requires http inbound only: a websocket inbound transport is a mismatch', () => {
    expect(configMismatches(sharedConfig, { ...sharedConfig, inboundTransports: ['http', 'ws'] })).toEqual([
      'inboundTransports'
    ]);
  });

  it('requires both http and ws outbound', () => {
    expect(configMismatches(sharedConfig, { ...sharedConfig, outboundTransports: ['http'] })).toEqual([
      'outboundTransports'
    ]);
  });
});
