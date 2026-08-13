import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class UserRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();

    const { user } = request;

    // Reverted from realm_access.roles back to develop's userRole (the Keycloak *user attribute*
    // jwt.strategy.ts copies onto userDetails as userDetails['userRole']) — realm_access.roles is
    // a different, unprovisioned mechanism: nothing in this PR grants a 'holder' realm role, so
    // every currently-working cloud-wallet endpoint (all behind this guard) would start 403ing.
    // Also, `.roles` without the guard's own optional chaining threw a 500 for any token whose
    // payload has no realm_access claim at all. See the #71 review.
    if (!user?.userRole) {
      throw new ForbiddenException('This role is not a holder.');
    }

    if (!user?.userRole.includes('holder')) {
      throw new ForbiddenException('This role is not a holder.');
    }

    return true;
  }
}
