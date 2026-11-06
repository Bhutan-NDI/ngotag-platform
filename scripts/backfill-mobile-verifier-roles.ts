/* eslint-disable camelcase */
/* eslint-disable no-console */
// One-off backfill for organizations registered before the mobile-verifier permission roles
// existed. registerToKeycloak creates the ALLOW_PROOF_TEMPLATE / ALLOW_VERIFIER client roles only
// for NEW organizations, so on existing ones those roles don't exist in Keycloak: they can't be
// assigned and every write to mobile-verifier is refused with a 403. This creates the missing
// client roles on each organization's Keycloak client. Idempotent: roles that already exist are
// left alone, so it is safe to re-run.
//
// (The matching org_roles rows are inserted by the 20260910120000_add_mobile_verifier_tables
// migration, not by this script.)
//
// Usage: DATABASE_URL=... KEYCLOAK_DOMAIN=... KEYCLOAK_REALM=... \
//        KEYCLOAK_MANAGEMENT_CLIENT_ID=... KEYCLOAK_MANAGEMENT_CLIENT_SECRET=... \
//        npx ts-node scripts/backfill-mobile-verifier-roles.ts [--dry-run]

import { PrismaClient } from '@prisma/client';

const log = (msg: string): void => console.log(`[MV-ROLES] ${msg}`);

export const MOBILE_VERIFIER_CLIENT_ROLES = [
  {
    name: 'ALLOW_PROOF_TEMPLATE',
    description: 'Allows creating mobile-verifier proof templates for this organization'
  },
  { name: 'ALLOW_VERIFIER', description: 'Allows creating mobile-verifier verifier roles for this organization' }
];

export interface OrgClient {
  id: string;
  name: string;
  idpId: string;
}

// The slice of the Keycloak admin API this script needs; injectable so it can be tested without Keycloak.
export interface KeycloakRoleApi {
  listClientRoleNames: (idpId: string) => Promise<string[]>;
  createClientRole: (idpId: string, name: string, description: string) => Promise<void>;
}

export const findMissingRoles = (existingRoleNames: string[]): typeof MOBILE_VERIFIER_CLIENT_ROLES => {
  const existing = new Set(existingRoleNames);
  return MOBILE_VERIFIER_CLIENT_ROLES.filter((role) => !existing.has(role.name));
};

export interface BackfillSummary {
  organizations: number;
  alreadyComplete: number;
  rolesCreated: number;
  failed: { orgId: string; error: string }[];
}

export const backfillMobileVerifierRoles = async (
  orgs: OrgClient[],
  keycloak: KeycloakRoleApi,
  dryRun: boolean
): Promise<BackfillSummary> => {
  const summary: BackfillSummary = { organizations: orgs.length, alreadyComplete: 0, rolesCreated: 0, failed: [] };

  for (const org of orgs) {
    // One organization failing must not stop the rest.
    try {
      const missing = findMissingRoles(await keycloak.listClientRoleNames(org.idpId));

      if (0 === missing.length) {
        summary.alreadyComplete += 1;
        continue;
      }

      for (const role of missing) {
        log(`${dryRun ? '[dry-run] would create' : 'creating'} ${role.name} on "${org.name}" (${org.id})`);
        if (!dryRun) {
          await keycloak.createClientRole(org.idpId, role.name, role.description);
        }
        summary.rolesCreated += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`FAILED for "${org.name}" (${org.id}): ${message}`);
      summary.failed.push({ orgId: org.id, error: message });
    }
  }

  return summary;
};

// Keycloak access: same grant and endpoints the platform's ClientRegistrationService uses.
export const createKeycloakRoleApi = (
  env: { domain: string; realm: string; managementClientId: string; managementClientSecret: string },
  fetchFn: typeof fetch = fetch
): KeycloakRoleApi => {
  let token: Promise<string> | undefined;
  const getToken = (): Promise<string> => {
    token ??= (async (): Promise<string> => {
      const response = await fetchFn(`${env.domain}realms/${env.realm}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: env.managementClientId,
          client_secret: env.managementClientSecret
        }).toString()
      });
      if (!response.ok) {
        throw new Error(`Keycloak token request failed with ${response.status}`);
      }
      return ((await response.json()) as { access_token: string }).access_token;
    })();
    return token;
  };
  const rolesUrl = (idpId: string): string =>
    `${env.domain}admin/realms/${env.realm}/clients/${encodeURIComponent(idpId)}/roles`;

  return {
    listClientRoleNames: async (idpId: string): Promise<string[]> => {
      const response = await fetchFn(rolesUrl(idpId), { headers: { Authorization: `Bearer ${await getToken()}` } });
      if (!response.ok) {
        throw new Error(`Listing client roles failed with ${response.status}`);
      }
      return ((await response.json()) as { name: string }[]).map((role) => role.name);
    },
    createClientRole: async (idpId: string, name: string, description: string): Promise<void> => {
      const response = await fetchFn(rolesUrl(idpId), {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRole: true, name, description })
      });
      // 409 = created in the meantime by someone else; the goal state is reached either way.
      if (!response.ok && 409 !== response.status) {
        throw new Error(`Creating client role ${name} failed with ${response.status}`);
      }
    }
  };
};

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes('--dry-run');
  const { KEYCLOAK_DOMAIN, KEYCLOAK_REALM, KEYCLOAK_MANAGEMENT_CLIENT_ID, KEYCLOAK_MANAGEMENT_CLIENT_SECRET } =
    process.env;
  if (!KEYCLOAK_DOMAIN || !KEYCLOAK_REALM || !KEYCLOAK_MANAGEMENT_CLIENT_ID || !KEYCLOAK_MANAGEMENT_CLIENT_SECRET) {
    throw new Error(
      'KEYCLOAK_DOMAIN, KEYCLOAK_REALM, KEYCLOAK_MANAGEMENT_CLIENT_ID and KEYCLOAK_MANAGEMENT_CLIENT_SECRET are required'
    );
  }

  const prisma = new PrismaClient();
  try {
    const organisations = await prisma.organisation.findMany({
      where: { idpId: { not: null } },
      select: { id: true, name: true, idpId: true }
    });
    const orgs: OrgClient[] = organisations.map((org) => ({ id: org.id, name: org.name, idpId: org.idpId }));
    log(`${dryRun ? 'DRY RUN — ' : ''}checking ${orgs.length} organization(s) with a Keycloak client`);

    const summary = await backfillMobileVerifierRoles(
      orgs,
      createKeycloakRoleApi({
        domain: KEYCLOAK_DOMAIN,
        realm: KEYCLOAK_REALM,
        managementClientId: KEYCLOAK_MANAGEMENT_CLIENT_ID,
        managementClientSecret: KEYCLOAK_MANAGEMENT_CLIENT_SECRET
      }),
      dryRun
    );

    log(
      `${summary.organizations} organization(s): ${summary.alreadyComplete} already complete, ` +
        `${summary.rolesCreated} role(s) ${dryRun ? 'to create' : 'created'}, ${summary.failed.length} failed`
    );
    if (0 < summary.failed.length) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
