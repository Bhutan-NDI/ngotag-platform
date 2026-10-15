/* eslint-disable camelcase */
import {
  MOBILE_VERIFIER_CLIENT_ROLES,
  OrgClient,
  KeycloakRoleApi,
  backfillMobileVerifierRoles,
  createKeycloakRoleApi,
  findMissingRoles
} from './backfill-mobile-verifier-roles';

const orgs: OrgClient[] = [
  { id: 'org-1', name: 'Has none', idpId: 'idp-1' },
  { id: 'org-2', name: 'Has one', idpId: 'idp-2' },
  { id: 'org-3', name: 'Has both', idpId: 'idp-3' }
];

// In-memory Keycloak: client roles per idpId.
const fakeKeycloak = (initial: Record<string, string[]>): KeycloakRoleApi & { state: Record<string, string[]> } => {
  const state = JSON.parse(JSON.stringify(initial)) as Record<string, string[]>;
  return {
    state,
    listClientRoleNames: jest.fn(async (idpId: string) => state[idpId]),
    createClientRole: jest.fn(async (idpId: string, name: string) => {
      state[idpId].push(name);
    })
  };
};
const start = {
  'idp-1': ['owner'],
  'idp-2': ['owner', 'ALLOW_VERIFIER'],
  'idp-3': ['owner', 'ALLOW_VERIFIER', 'ALLOW_PROOF_TEMPLATE']
};

describe('findMissingRoles', () => {
  it('returns only the roles that are not there yet', () => {
    expect(findMissingRoles(['owner']).map((r) => r.name)).toEqual(['ALLOW_PROOF_TEMPLATE', 'ALLOW_VERIFIER']);
    expect(findMissingRoles(['ALLOW_VERIFIER']).map((r) => r.name)).toEqual(['ALLOW_PROOF_TEMPLATE']);
    expect(findMissingRoles(MOBILE_VERIFIER_CLIENT_ROLES.map((r) => r.name))).toEqual([]);
  });
});

describe('backfillMobileVerifierRoles', () => {
  it('creates only the missing roles, per organization', async () => {
    const keycloak = fakeKeycloak(start);
    const summary = await backfillMobileVerifierRoles(orgs, keycloak, false);

    expect(keycloak.state['idp-1']).toEqual(['owner', 'ALLOW_PROOF_TEMPLATE', 'ALLOW_VERIFIER']);
    expect(keycloak.state['idp-2']).toEqual(['owner', 'ALLOW_VERIFIER', 'ALLOW_PROOF_TEMPLATE']);
    expect(keycloak.state['idp-3']).toEqual(start['idp-3']);
    expect(summary).toEqual({ organizations: 3, alreadyComplete: 1, rolesCreated: 3, failed: [] });
  });

  it('is idempotent: a second run changes nothing', async () => {
    const keycloak = fakeKeycloak(start);
    await backfillMobileVerifierRoles(orgs, keycloak, false);
    (keycloak.createClientRole as jest.Mock).mockClear();

    const second = await backfillMobileVerifierRoles(orgs, keycloak, false);

    expect(keycloak.createClientRole).not.toHaveBeenCalled();
    expect(second).toEqual({ organizations: 3, alreadyComplete: 3, rolesCreated: 0, failed: [] });
  });

  it('dry run reports what it would do and writes nothing', async () => {
    const keycloak = fakeKeycloak(start);
    const summary = await backfillMobileVerifierRoles(orgs, keycloak, true);

    expect(keycloak.createClientRole).not.toHaveBeenCalled();
    expect(keycloak.state).toEqual(start);
    expect(summary.rolesCreated).toBe(3);
  });

  it('one failing organization does not stop the others', async () => {
    const keycloak = fakeKeycloak(start);
    (keycloak.listClientRoleNames as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('Listing client roles failed with 404');
    });
    const summary = await backfillMobileVerifierRoles(orgs, keycloak, false);

    expect(summary.failed).toEqual([{ orgId: 'org-1', error: 'Listing client roles failed with 404' }]);
    expect(keycloak.state['idp-2']).toContain('ALLOW_PROOF_TEMPLATE');
    expect(summary.alreadyComplete).toBe(1);
  });
});

describe('createKeycloakRoleApi (HTTP shape, mocked fetch)', () => {
  const env = { domain: 'http://kc/', realm: 'realm', managementClientId: 'mgmt', managementClientSecret: 's3cret' };
  const json = (body: unknown, status = 200): Response =>
    ({ ok: 200 <= status && 300 > status, status, json: async () => body }) as Response;

  it('authenticates with client credentials once and calls the admin roles endpoint', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith('/openid-connect/token') ? json({ access_token: 'T' }) : json([{ name: 'owner' }]);
    });
    const api = createKeycloakRoleApi(env, fetchFn as unknown as typeof fetch);

    expect(await api.listClientRoleNames('idp/1')).toEqual(['owner']);
    await api.listClientRoleNames('idp-2');

    expect(calls[0].url).toBe('http://kc/realms/realm/protocol/openid-connect/token');
    expect(String(calls[0].init?.body)).toBe('grant_type=client_credentials&client_id=mgmt&client_secret=s3cret');
    expect(calls[1].url).toBe('http://kc/admin/realms/realm/clients/idp%2F1/roles');
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer T');
    expect(calls.filter((c) => c.url.endsWith('/openid-connect/token'))).toHaveLength(1);
  });

  it('creates a client role with the same payload the platform uses, and tolerates 409', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'T' }))
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({}, 500));
    const api = createKeycloakRoleApi(env, fetchFn as unknown as typeof fetch);

    await expect(api.createClientRole('idp-1', 'ALLOW_VERIFIER', 'desc')).resolves.toBeUndefined();
    const [, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ clientRole: true, name: 'ALLOW_VERIFIER', description: 'desc' });
    await expect(api.createClientRole('idp-1', 'ALLOW_VERIFIER', 'desc')).rejects.toThrow('failed with 500');
  });

  it('fails clearly when the management login is refused', async () => {
    const api = createKeycloakRoleApi(env, jest.fn(async () => json({}, 401)) as unknown as typeof fetch);
    await expect(api.listClientRoleNames('idp-1')).rejects.toThrow('token request failed with 401');
  });
});
