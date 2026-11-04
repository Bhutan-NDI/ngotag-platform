import * as jwt from 'jsonwebtoken';

interface DecodedAccessToken {
  sub?: string;
  resource_access?: Record<string, { roles: string[] }>;
}

// api-gateway already verifies the token's signature (passport-jwt) before forwarding it
// here over NATS — this only decodes it to read the caller's Keycloak client roles for
// their own org, it does not re-verify.
const decodeToken = (authorization: string | undefined): DecodedAccessToken | null => {
  if (!authorization) {
    return null;
  }
  const token = authorization.replace(/^Bearer\s+/i, '');
  return jwt.decode(token) as DecodedAccessToken | null;
};

export const getResourceRoles = (authorization: string | undefined, orgId: string): string[] => {
  const roles = decodeToken(authorization)?.resource_access?.[orgId]?.roles;
  return roles ?? [];
};

// The caller's Keycloak user id, which is user.keycloakUserId in the platform's DB.
export const getTokenSubject = (authorization: string | undefined): string | undefined => {
  const decoded = decodeToken(authorization);
  return decoded?.sub;
};
