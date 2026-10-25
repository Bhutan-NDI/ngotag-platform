import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

// Admits only the one Keycloak service client (client-credentials grant) that the mobile-verifier
// core backend authenticates as. AuthGuard('jwt') must run first: it has already verified the
// signature, but JwtStrategy derives the JWKS URL from the token's own `iss`, so a token signed by
// any other issuer would pass it. The issuer is therefore pinned here to the platform realm, and
// the caller is matched on its exact client id rather than on "any non-UUID client_id".
@Injectable()
export class MobileVerifierServiceClientGuard implements CanActivate {
  private readonly logger = new Logger('MobileVerifierServiceClientGuard');

  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();

    const allowedClientId = process.env.MOBILE_VERIFIER_SERVICE_CLIENT_ID;
    const { KEYCLOAK_DOMAIN, KEYCLOAK_REALM } = process.env;

    // Fail closed: an unconfigured deployment must not expose the endpoint.
    if (!allowedClientId || !KEYCLOAK_DOMAIN || !KEYCLOAK_REALM) {
      this.logger.error('MOBILE_VERIFIER_SERVICE_CLIENT_ID, KEYCLOAK_DOMAIN or KEYCLOAK_REALM is not set');
      throw new UnauthorizedException('You do not have access');
    }

    const expectedIssuer = `${stripTrailingSlash(KEYCLOAK_DOMAIN)}/realms/${KEYCLOAK_REALM}`;

    if (
      !user?.client_id ||
      user.client_id !== allowedClientId ||
      stripTrailingSlash(user.iss ?? '') !== expectedIssuer
    ) {
      throw new UnauthorizedException('You do not have access');
    }

    return true;
  }
}
