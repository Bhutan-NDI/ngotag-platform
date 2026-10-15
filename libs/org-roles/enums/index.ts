export enum OrgRoles {
  OWNER = 'owner',
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  ISSUER = 'issuer',
  VERIFIER = 'verifier',
  HOLDER = 'holder',
  MEMBER = 'member',
  PLATFORM_ADMIN = 'platform_admin',
  ECOSYSTEM_LEAD = 'Ecosystem Lead',
  ECOSYSTEM_MEMBER = 'Ecosystem Member',
  // mobile-verifier permission roles: gate proof-template/verifier-role creation there.
  // Created unconditionally on every org's Keycloak client at registration time (see
  // apps/organization/src/organization.service.ts registerToKeycloak), then checked by
  // mobile-verifier by decoding resource_access[orgId].roles from the caller's JWT.
  ALLOW_PROOF_TEMPLATE = 'ALLOW_PROOF_TEMPLATE',
  ALLOW_VERIFIER = 'ALLOW_VERIFIER'
}

export enum EcosystemRoles {
  ECOSYSTEM_LEAD = 'Ecosystem Lead',
  ECOSYSTEM_MEMBER = 'Ecosystem Member'
}
