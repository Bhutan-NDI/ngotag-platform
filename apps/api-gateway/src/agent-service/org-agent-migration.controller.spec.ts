/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, no-mixed-operators */
/**
 * The wallet-move routes run behind the real OrgRolesGuard, StepUpAuthGuard, validation pipe and exception filter.
 * Only the JWT check (it just supplies the user) and the NATS-backed service are faked.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { OrgAgentMigrationController } from './org-agent-migration.controller';
import { OrgAgentMigrationService } from './org-agent-migration.service';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER_ORG_ID = '9b2c1a4e-1d3f-4c55-8a7e-2f6b9d0c1e11';
const PLATFORM_ORG_ID = '7c1e2d3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

const membership = (orgId: string, role: string) => ({ orgId, orgRole: { name: role } });
const minutesAgo = (minutes: number): Date => {
  const offsetMs = minutes * 60000;
  return new Date(Date.now() - offsetMs);
};

const userWith = (roles: ReturnType<typeof membership>[], overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  sub: 'keycloak-1',
  sid: 'session-1',
  sessionCreatedAt: minutesAgo(1),
  userOrgRoles: roles,
  ...overrides
});

const owner = (overrides = {}) => userWith([membership(ORG_ID, 'owner')], overrides);

const validBody = {
  targetAdminEndpoint: 'https://admin.agent.example.org',
  targetDidcommEndpoint: 'https://didcomm.agent.example.org',
  apiKey: 'the-agent-api-key',
  backupsConfirmed: true
};

describe('wallet move routes', () => {
  let app: INestApplication;
  let currentUser: unknown;
  const service = {
    create: jest.fn(),
    preflight: jest.fn(),
    rehearse: jest.fn(),
    start: jest.fn(),
    cancel: jest.fn(),
    disasterRestore: jest.fn(),
    get: jest.fn(),
    list: jest.fn(),
    confirmWebhook: jest.fn()
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrgAgentMigrationController],
      providers: [{ provide: OrgAgentMigrationService, useValue: service }]
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = currentUser;
          return true;
        }
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    currentUser = owner();
    Object.values(service).forEach((fn) => fn.mockReset().mockResolvedValue({ migration: { id: 'm1' } }));
  });

  describe('POST /orgs/:orgId/agents/migrate', () => {
    it('lets an owner with a fresh sign-in start a move, as the user in the token and the org in the path', async () => {
      const response = await request(app.getHttpServer())
        .post(`/orgs/${ORG_ID}/agents/migrate`)
        .send({ ...validBody, userId: 'someone-else', orgId: OTHER_ORG_ID });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ statusCode: 201, data: { migration: { id: 'm1' } } });
      expect(service.create).toHaveBeenCalledWith(ORG_ID, 'user-1', validBody);
    });

    it('asks for a new sign-in when the session is older than five minutes', async () => {
      currentUser = owner({ sessionCreatedAt: minutesAgo(10) });

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate`).send(validBody);

      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).toContain('STEP_UP_REQUIRED');
      expect(service.create).not.toHaveBeenCalled();
    });

    it('answers a non-owner with 403 even when their session is stale, so they are not sent to sign in again', async () => {
      currentUser = userWith([membership(ORG_ID, 'admin')], { sessionCreatedAt: minutesAgo(60) });

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate`).send(validBody);

      expect(response.status).toBe(403);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('refuses an owner of a different organisation', async () => {
      currentUser = userWith([membership(OTHER_ORG_ID, 'owner')]);

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate`).send(validBody);

      expect(response.status).toBe(403);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('refuses a service token, which has no sign-in to be fresh', async () => {
      currentUser = owner({ client_id: 'service-client' });

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate`).send(validBody);

      expect(response.status).toBe(401);
      expect(service.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an http admin address', { targetAdminEndpoint: 'http://admin.agent.example.org' }],
      ['an http DIDComm address', { targetDidcommEndpoint: 'http://didcomm.agent.example.org' }],
      ['a missing admin address', { targetAdminEndpoint: undefined }],
      ['a missing API key', { apiKey: undefined }],
      ['an empty API key', { apiKey: '' }],
      ['a non-boolean backups confirmation', { backupsConfirmed: 'yes' }]
    ])('rejects %s with 400', async (_name, change) => {
      const response = await request(app.getHttpServer())
        .post(`/orgs/${ORG_ID}/agents/migrate`)
        .send({ ...validBody, ...change });

      expect(response.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects an org id that is not a UUID', async () => {
      const response = await request(app.getHttpServer()).post('/orgs/not-a-uuid/agents/migrate').send(validBody);

      expect(response.status).toBe(400);
    });

    it('does not echo the API key back', async () => {
      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate`).send(validBody);

      expect(JSON.stringify(response.body)).not.toContain('the-agent-api-key');
    });
  });

  describe('POST /orgs/:orgId/agents/migrate/preflight', () => {
    it('lets an owner re-run the checks without a fresh sign-in', async () => {
      currentUser = owner({ sessionCreatedAt: minutesAgo(120) });

      const response = await request(app.getHttpServer())
        .post(`/orgs/${ORG_ID}/agents/migrate/preflight`)
        .send({ apiKey: 'new-key', backupsConfirmed: true });

      expect(response.status).toBe(200);
      expect(service.preflight).toHaveBeenCalledWith(ORG_ID, 'user-1', { apiKey: 'new-key', backupsConfirmed: true });
    });

    it('accepts an empty body', async () => {
      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/preflight`).send({});

      expect(response.status).toBe(200);
    });

    it('refuses a non-owner', async () => {
      currentUser = userWith([membership(ORG_ID, 'issuer')]);

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/preflight`).send({});

      expect(response.status).toBe(403);
      expect(service.preflight).not.toHaveBeenCalled();
    });
  });

  describe('POST /orgs/:orgId/agents/migrate/rehearse', () => {
    it('answers 202 for an owner and starts the rehearsal as them', async () => {
      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/rehearse`).send();

      expect(response.status).toBe(202);
      expect(service.rehearse).toHaveBeenCalledWith(ORG_ID, 'user-1');
    });

    it.each(['admin', 'super_admin', 'issuer', 'verifier', 'member'])('refuses a %s', async (role) => {
      currentUser = userWith([membership(ORG_ID, role)]);

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/rehearse`).send();

      expect(response.status).toBe(403);
      expect(service.rehearse).not.toHaveBeenCalled();
    });

    it('refuses a platform admin who is not an owner of the org', async () => {
      currentUser = userWith([membership(PLATFORM_ORG_ID, 'platform_admin')]);

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/rehearse`).send();

      expect(response.status).toBe(403);
    });
  });

  describe('POST /orgs/:orgId/agents/migrate/start', () => {
    const slot = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

    it('lets an owner confirm the move with the typed name and a slot, as the user in the token', async () => {
      const response = await request(app.getHttpServer())
        .post(`/orgs/${ORG_ID}/agents/migrate/start`)
        .send({ confirmationName: 'Acme Ltd', scheduledFor: slot, userId: 'someone-else' });

      expect(response.status).toBe(200);
      expect(service.start).toHaveBeenCalledWith(ORG_ID, 'user-1', {
        confirmationName: 'Acme Ltd',
        scheduledFor: slot
      });
    });

    it('lets an owner start at once by leaving the slot out', async () => {
      const response = await request(app.getHttpServer())
        .post(`/orgs/${ORG_ID}/agents/migrate/start`)
        .send({ confirmationName: 'Acme Ltd' });

      expect(response.status).toBe(200);
      expect(service.start).toHaveBeenCalledWith(ORG_ID, 'user-1', { confirmationName: 'Acme Ltd' });
    });

    it('does not ask for a fresh sign-in: the endpoints were fixed when the move was created', async () => {
      currentUser = owner({ sessionCreatedAt: minutesAgo(180) });

      const response = await request(app.getHttpServer())
        .post(`/orgs/${ORG_ID}/agents/migrate/start`)
        .send({ confirmationName: 'Acme Ltd' });

      expect(response.status).toBe(200);
    });

    it.each(['admin', 'super_admin', 'issuer', 'verifier', 'member'])('refuses a %s', async (role) => {
      currentUser = userWith([membership(ORG_ID, role)]);

      const response = await request(app.getHttpServer())
        .post(`/orgs/${ORG_ID}/agents/migrate/start`)
        .send({ confirmationName: 'Acme Ltd' });

      expect(response.status).toBe(403);
      expect(service.start).not.toHaveBeenCalled();
    });

    it('refuses an owner of a different organisation', async () => {
      currentUser = userWith([membership(OTHER_ORG_ID, 'owner')]);

      const response = await request(app.getHttpServer())
        .post(`/orgs/${ORG_ID}/agents/migrate/start`)
        .send({ confirmationName: 'Acme Ltd' });

      expect(response.status).toBe(403);
    });

    it.each([
      ['no typed name', {}],
      ['an empty typed name', { confirmationName: '' }],
      ['a typed name that is not text', { confirmationName: 5 }],
      ['a slot that is not a date', { confirmationName: 'Acme Ltd', scheduledFor: 'tomorrow-ish' }]
    ])('rejects %s with 400', async (_name, body) => {
      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/start`).send(body);

      expect(response.status).toBe(400);
      expect(service.start).not.toHaveBeenCalled();
    });
  });

  describe('POST /orgs/:orgId/agents/migrate/cancel', () => {
    it('lets an owner cancel the move, as the user in the token', async () => {
      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/cancel`).send();

      expect(response.status).toBe(200);
      expect(service.cancel).toHaveBeenCalledWith(ORG_ID, 'user-1');
    });

    it('does not ask for a fresh sign-in', async () => {
      currentUser = owner({ sessionCreatedAt: minutesAgo(240) });

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/cancel`).send();

      expect(response.status).toBe(200);
    });

    it.each(['admin', 'super_admin', 'issuer', 'verifier', 'member'])('refuses a %s', async (role) => {
      currentUser = userWith([membership(ORG_ID, role)]);

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/cancel`).send();

      expect(response.status).toBe(403);
      expect(service.cancel).not.toHaveBeenCalled();
    });

    it('refuses an owner of a different organisation', async () => {
      currentUser = userWith([membership(OTHER_ORG_ID, 'owner')]);

      const response = await request(app.getHttpServer()).post(`/orgs/${ORG_ID}/agents/migrate/cancel`).send();

      expect(response.status).toBe(403);
    });

    it('rejects an org id that is not a UUID', async () => {
      const response = await request(app.getHttpServer()).post('/orgs/not-a-uuid/agents/migrate/cancel').send();

      expect(response.status).toBe(400);
    });
  });

  describe('GET /orgs/:orgId/agents/migrate', () => {
    it.each(['owner', 'admin', 'member', 'issuer', 'verifier'])('shows the move to a %s of the org', async (role) => {
      currentUser = userWith([membership(ORG_ID, role)]);

      const response = await request(app.getHttpServer()).get(`/orgs/${ORG_ID}/agents/migrate`);

      expect(response.status).toBe(200);
      expect(service.get).toHaveBeenCalledWith(ORG_ID);
    });

    it('answers 200 with no data for an organisation that has never moved', async () => {
      service.get.mockResolvedValue(null);

      const response = await request(app.getHttpServer()).get(`/orgs/${ORG_ID}/agents/migrate`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeNull();
    });

    it('does not show it to someone outside the org', async () => {
      currentUser = userWith([membership(OTHER_ORG_ID, 'owner')]);

      const response = await request(app.getHttpServer()).get(`/orgs/${ORG_ID}/agents/migrate`);

      expect(response.status).toBe(403);
      expect(service.get).not.toHaveBeenCalled();
    });

    it('does not show it to a holder', async () => {
      currentUser = userWith([membership(ORG_ID, 'owner')], { userRole: 'holder' });

      const response = await request(app.getHttpServer()).get(`/orgs/${ORG_ID}/agents/migrate`);

      expect(response.status).toBe(403);
    });
  });

  describe('POST /agents/migrations/:targetOrgId/disaster-restore', () => {
    const admin = () => userWith([membership(PLATFORM_ORG_ID, 'platform_admin')]);
    const restore = (orgId = ORG_ID, body: object = { acknowledgeLosses: true }) =>
      request(app.getHttpServer()).post(`/agents/migrations/${orgId}/disaster-restore`).send(body);

    it('lets a platform admin who is not a member of the org roll its move back, as the user in the token', async () => {
      currentUser = admin();

      const response = await restore();

      expect(response.status).toBe(200);
      expect(service.disasterRestore).toHaveBeenCalledWith(ORG_ID, 'user-1');
    });

    it('refuses an owner of that very organisation: only the platform team can roll back', async () => {
      const response = await restore();

      expect(response.status).toBe(403);
      expect(service.disasterRestore).not.toHaveBeenCalled();
    });

    it.each(['admin', 'super_admin', 'issuer', 'member'])('refuses a %s of the organisation', async (role) => {
      currentUser = userWith([membership(ORG_ID, role)]);

      const response = await restore();

      expect(response.status).toBe(403);
    });

    it.each([
      ['no acknowledgement', {}],
      ['an acknowledgement of false', { acknowledgeLosses: false }],
      ['an acknowledgement that is not a boolean', { acknowledgeLosses: 'yes' }]
    ])('refuses %s: the losses must be acknowledged', async (_name, body) => {
      currentUser = admin();

      const response = await restore(ORG_ID, body);

      expect(response.status).toBe(400);
      expect(service.disasterRestore).not.toHaveBeenCalled();
    });

    it('rejects an org id that is not a UUID', async () => {
      currentUser = admin();

      const response = await restore('not-a-uuid');

      expect(response.status).toBe(400);
    });
  });

  describe('GET /agents/migrations', () => {
    const admin = () => userWith([membership(PLATFORM_ORG_ID, 'platform_admin')]);

    it('lets a platform admin list moves across organisations, filtered by targetOrgId and status', async () => {
      currentUser = admin();

      const response = await request(app.getHttpServer()).get(
        `/agents/migrations?targetOrgId=${ORG_ID}&status=STABILISING&pageNumber=2&pageSize=5`
      );

      expect(response.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(
        expect.objectContaining({ targetOrgId: ORG_ID, status: 'STABILISING', pageNumber: 2, pageSize: 5 })
      );
    });

    it('works with no filter at all', async () => {
      currentUser = admin();

      const response = await request(app.getHttpServer()).get('/agents/migrations');

      expect(response.status).toBe(200);
    });

    it('refuses an owner who is not a platform admin', async () => {
      const response = await request(app.getHttpServer()).get('/agents/migrations');

      expect(response.status).toBe(403);
      expect(service.list).not.toHaveBeenCalled();
    });

    it('would refuse a non-member admin if the filter were called orgId, which is why it is targetOrgId', async () => {
      currentUser = admin();

      const response = await request(app.getHttpServer()).get(`/agents/migrations?orgId=${ORG_ID}`);

      expect(response.status).toBe(403);
    });

    it.each([
      ['an unknown status', 'status=ARCHIVED'],
      ['a page size above 100', 'pageSize=101'],
      ['a page number of zero', 'pageNumber=0'],
      ['a targetOrgId that is not a UUID', 'targetOrgId=abc']
    ])('rejects %s with 400', async (_name, query) => {
      currentUser = admin();

      const response = await request(app.getHttpServer()).get(`/agents/migrations?${query}`);

      expect(response.status).toBe(400);
      expect(service.list).not.toHaveBeenCalled();
    });
  });

  describe('POST /wh/:orgId/probe', () => {
    const PROBE_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

    it('needs no sign-in, and answers 200 for the live probe of that org', async () => {
      currentUser = undefined;
      service.confirmWebhook.mockResolvedValue({ confirmed: true });

      const response = await request(app.getHttpServer())
        .post(`/wh/${ORG_ID}/probe`)
        .send({ type: 'WebhookProbe', probeId: PROBE_ID });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ confirmed: true });
      expect(service.confirmWebhook).toHaveBeenCalledWith(ORG_ID, PROBE_ID);
    });

    it('answers 404 with nothing more for any other probe', async () => {
      service.confirmWebhook.mockResolvedValue({ confirmed: false });

      const response = await request(app.getHttpServer()).post(`/wh/${ORG_ID}/probe`).send({ probeId: PROBE_ID });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ confirmed: false });
    });

    it.each([
      ['no probe id', {}],
      ['a probe id that is not a UUID', { probeId: 'guess' }],
      ['a probe id that is not a string', { probeId: 5 }]
    ])('rejects %s with 400 and asks nothing', async (_name, body) => {
      const response = await request(app.getHttpServer()).post(`/wh/${ORG_ID}/probe`).send(body);

      expect(response.status).toBe(400);
      expect(service.confirmWebhook).not.toHaveBeenCalled();
    });

    it('rejects an org id that is not a UUID with 400', async () => {
      const response = await request(app.getHttpServer()).post('/wh/not-a-uuid/probe').send({ probeId: PROBE_ID });

      expect(response.status).toBe(400);
      expect(service.confirmWebhook).not.toHaveBeenCalled();
    });
  });
});
