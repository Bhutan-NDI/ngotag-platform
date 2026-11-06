import { HttpException, HttpStatus } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

interface DecodedAccessToken {
  resource_access?: Record<string, { roles: string[] }>;
}

// api-gateway already verifies the token's signature (passport-jwt) before forwarding it
// here over NATS — this only decodes it to read the caller's Keycloak client roles for
// their own org, it does not re-verify.
export const getResourceRoles = (authorization: string | undefined, orgId: string): string[] => {
  if (!authorization) {
    return [];
  }
  const token = authorization.replace(/^Bearer\s+/i, '');
  const decoded = jwt.decode(token) as DecodedAccessToken | null;
  return decoded?.resource_access?.[orgId]?.roles ?? [];
};

export const assertRole = (authorization: string | undefined, orgId: string, required: string | string[]): void => {
  const roles = getResourceRoles(authorization, orgId);
  const requiredList = Array.isArray(required) ? required : [required];
  if (!requiredList.some((role) => roles.includes(role))) {
    // NOTE: libs/http-exception.filter.ts only special-cases the exact HttpException class
    // (switch on exception.constructor), not its subclasses like ForbiddenException — those
    // fall through to a 500. Every other throw in this codebase uses `new HttpException(...)`
    // directly for exactly this reason.
    throw new HttpException(
      `Not authorized: missing required role (${requiredList.join(' or ')})`,
      HttpStatus.FORBIDDEN
    );
  }
};
