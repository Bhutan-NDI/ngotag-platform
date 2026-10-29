/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { HttpService } from '@nestjs/axios';
import * as http from 'http';
import { AddressInfo } from 'net';
import { of } from 'rxjs';
import { MigrationAgentClient, MigrationAgentError } from './migration-agent.client';

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

describe('MigrationAgentClient against a real HTTP server', () => {
  let server: http.Server;
  let baseUrl: string;
  let seen: Seen[];
  let respond: (request: Seen) => { status: number; body?: unknown };
  const client = new MigrationAgentClient(new HttpService());

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const entry: Seen = {
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString()
        };
        seen.push(entry);
        const { status, body } = respond(entry);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body ?? {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seen = [];
    respond = () => ({ status: 200, body: {} });
  });

  it('asks the agent to post a webhook test event, with the probe id in the body and the root token', async () => {
    respond = () => ({ status: 201, body: { configured: true, delivered: true, status: 200 } });

    await expect(client.probeWebhook(baseUrl, 'root-token', 'probe-1')).resolves.toEqual({
      configured: true,
      delivered: true,
      status: 200
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/agent/webhook/probe', authorization: 'root-token' });
    expect(JSON.parse(seen[0].body)).toEqual({ probeId: 'probe-1' });
  });

  it('reports an agent without the probe route as not found', async () => {
    respond = () => ({ status: 404 });

    await expect(client.probeWebhook(baseUrl, 'root-token', 'probe-1')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('exchanges the API key for a token, sending the key as the authorization header', async () => {
    respond = () => ({ status: 200, body: { token: 'root-token' } });

    await expect(client.createToken(`${baseUrl}/`, 'the-api-key')).resolves.toBe('root-token');

    expect(seen[0]).toMatchObject({ method: 'POST', url: '/agent/token', authorization: 'the-api-key' });
  });

  it('reads the agent info with the token', async () => {
    respond = () => ({ status: 200, body: { endpoints: ['https://agent.example.org'], isInitialized: true } });

    await expect(client.getAgentInfo(baseUrl, 'tok')).resolves.toMatchObject({ isInitialized: true });

    expect(seen[0]).toMatchObject({ method: 'GET', url: '/agent', authorization: 'tok' });
  });

  it('starts a sealed export for the tenant, sealed to the recipient key', async () => {
    respond = () => ({ status: 200, body: { jobId: 'j1', status: 'pending' } });

    await client.startSealedExport(baseUrl, 'tok', 'tenant-1', 'cmVjaXBpZW50');

    expect(seen[0]).toMatchObject({ method: 'POST', url: '/multi-tenancy/export/tenant-1' });
    expect(JSON.parse(seen[0].body)).toEqual({ recipientPublicKey: 'cmVjaXBpZW50' });
  });

  it('reads an export job, deletes an export and probes a relay target on the documented routes', async () => {
    await client.getExportJob(baseUrl, 'tok', 'tenant-1', 'job-1');
    await client.deleteExport(baseUrl, 'tok', 'tenant-1', 'job-1');
    await client.probeRelayTarget(baseUrl, 'tok', 'tenant-1', 'https://org.example.org/didcomm');
    await client.getRelayHealth(baseUrl, 'tok');
    await client.getEndpointSchemes(baseUrl, 'tok', 'tenant-1');

    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /multi-tenancy/export/tenant-1/status/job-1',
      'DELETE /multi-tenancy/export/tenant-1/job-1',
      'POST /multi-tenancy/relay/tenant-1/probe',
      'GET /multi-tenancy/relay/health',
      'GET /multi-tenancy/tenant-1/endpoint-schemes'
    ]);
    expect(JSON.parse(seen[2].body)).toEqual({ target: 'https://org.example.org/didcomm' });
  });

  it('creates an import session, starts an import and polls it on the documented routes', async () => {
    const body = {
      sessionId: 's1',
      exportUrl: 'https://bucket.s3.amazonaws.com/x',
      checksum: 'a'.repeat(64),
      sealedStoreKey: 'a2V5',
      storageVersion: '0.5',
      dryRun: true
    };

    await client.createImportSession(baseUrl, 'tok');
    await client.startImport(baseUrl, 'tok', body);
    await client.getImportJob(baseUrl, 'tok', 'job 1');

    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST /agent/wallet/import-session',
      'POST /agent/wallet/import',
      'GET /agent/wallet/import/status/job%201'
    ]);
    expect(JSON.parse(seen[1].body)).toEqual(body);
  });

  it('gives a re-inject much longer than the default call, since the agent waits on each held message', async () => {
    const httpService = { request: jest.fn(() => of({ data: { injected: 0, failed: 0 } })) };
    const slowClient = new MigrationAgentClient(httpService as never);

    await slowClient.reinjectRelay(baseUrl, 'tok', 'tenant-1');

    expect(httpService.request).toHaveBeenCalledWith(expect.objectContaining({ timeout: 10 * 60 * 1000 }));
  });

  it('sets, re-injects and removes a relay on the documented routes', async () => {
    await client.putRelay(baseUrl, 'tok', 'tenant-1', { mode: 'FORWARD', target: 'https://didcomm.example.org' });
    await client.putRelay(baseUrl, 'tok', 'tenant-1', { mode: 'HOLD' });
    await client.reinjectRelay(baseUrl, 'tok', 'tenant-1');
    await client.deleteRelay(baseUrl, 'tok', 'tenant-1');

    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'PUT /multi-tenancy/relay/tenant-1',
      'PUT /multi-tenancy/relay/tenant-1',
      'POST /multi-tenancy/relay/tenant-1/reinject',
      'DELETE /multi-tenancy/relay/tenant-1'
    ]);
    expect(JSON.parse(seen[0].body)).toEqual({ mode: 'FORWARD', target: 'https://didcomm.example.org' });
    expect(JSON.parse(seen[1].body)).toEqual({ mode: 'HOLD' });
  });

  it('signs a self-attested credential, verifies it, and creates an invitation on the documented routes', async () => {
    respond = () => ({ status: 200, body: { credential: { issuer: 'did:polygon:0xabc' } } });
    await client.createSelfAttestedCredential(baseUrl, 'tok', {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      credentialSubject: {},
      proofType: 'Ed25519Signature2018'
    });
    await client.verifyCredential(baseUrl, 'tok', { issuer: 'did:polygon:0xabc' });
    await client.createConnectionInvitation(baseUrl, 'tok', {
      multiUseInvitation: true,
      autoAcceptConnection: true,
      label: 'Acme'
    });

    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST /agent/credential/self-attested',
      'POST /agent/credential/verify',
      'POST /didcomm/oob/create-invitation'
    ]);
    expect(JSON.parse(seen[1].body)).toEqual({ credential: { issuer: 'did:polygon:0xabc' } });
    expect(JSON.parse(seen[2].body)).toEqual({ multiUseInvitation: true, autoAcceptConnection: true, label: 'Acme' });
  });

  it('reads a relay, purges a profile, and starts and reads the rotation on the documented routes', async () => {
    await client.getRelay(baseUrl, 'tok', 'tenant-1');
    await client.purgeProfile(baseUrl, 'tok', 'tenant-1');
    await client.startRotation(baseUrl, 'tok');
    await client.getRotationStatus(baseUrl, 'tok');

    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /multi-tenancy/relay/tenant-1',
      'POST /multi-tenancy/tenant-1/purge-profile',
      'POST /didcomm/connections/rotate-all',
      'GET /didcomm/connections/rotate-all/status'
    ]);
    expect(seen.every(({ authorization }) => 'tok' === authorization)).toBe(true);
  });

  it('restores a relay on the documented route', async () => {
    respond = () => ({ status: 200, body: { injected: 2, failed: 0 } });

    await expect(client.restoreRelay(baseUrl, 'tok', 'tenant-1')).resolves.toEqual({ injected: 2, failed: 0 });

    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/multi-tenancy/relay/tenant-1/restore',
      authorization: 'tok'
    });
  });

  it.each([
    [401, 'REJECTED'],
    [403, 'REJECTED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [500, 'FAILED']
  ])('classifies a %s answer as %s', async (status, kind) => {
    respond = () => ({ status, body: { message: 'TARGET_NOT_PRISTINE' } });

    const error = await client.createImportSession(baseUrl, 'tok').catch((e) => e);

    expect(error).toBeInstanceOf(MigrationAgentError);
    expect(error).toMatchObject({ kind, status });
  });

  it("carries the agent's own code on a conflict", async () => {
    respond = () => ({ status: 409, body: { message: 'TARGET_NOT_PRISTINE' } });

    const error = await client.createImportSession(baseUrl, 'tok').catch((e) => e);

    expect(error.agentCode).toBe('TARGET_NOT_PRISTINE');
  });

  it('reports an agent that cannot be reached', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const error = await client.getAgentInfo(`http://127.0.0.1:${port}`, 'tok').catch((e) => e);

    expect(error).toMatchObject({ kind: 'UNREACHABLE' });
  });

  it('never lets the token or API key into an error, its message or its serialised form', async () => {
    respond = () => ({ status: 401 });

    const failures = [
      await client.getAgentInfo(baseUrl, 'SECRET-TOKEN').catch((e) => e),
      await client.createToken(baseUrl, 'SECRET-API-KEY').catch((e) => e)
    ];

    for (const failure of failures) {
      expect(`${failure.message} ${JSON.stringify(failure)} ${failure.stack}`).not.toMatch(/SECRET/);
    }
  });
});

describe('MigrationAgentClient timeouts', () => {
  const timeoutOf = async (call: (client: MigrationAgentClient) => Promise<unknown>): Promise<number> => {
    const request = jest.fn(() => of({ data: {} }));
    await call(new MigrationAgentClient({ request } as never));
    return (request.mock.calls[0] as unknown as [{ timeout: number }])[0].timeout;
  };

  afterEach(() => {
    delete process.env.ORG_MIGRATION_RESTORE_TIMEOUT_MS;
  });

  it('gives an ordinary call 15 seconds', async () => {
    await expect(timeoutOf((client) => client.getRelay('https://shared.example.com', 'tok', 'tenant-1'))).resolves.toBe(
      15000
    );
  });

  it('gives the relay restore much longer, because it hands every queued message back before it answers', async () => {
    const timeout = await timeoutOf((client) => client.restoreRelay('https://shared.example.com', 'tok', 'tenant-1'));

    expect(timeout).toBeGreaterThan(15000);
  });

  it('reads the restore timeout from the environment', async () => {
    process.env.ORG_MIGRATION_RESTORE_TIMEOUT_MS = '45000';

    await expect(
      timeoutOf((client) => client.restoreRelay('https://shared.example.com', 'tok', 'tenant-1'))
    ).resolves.toBe(45000);
  });
});
