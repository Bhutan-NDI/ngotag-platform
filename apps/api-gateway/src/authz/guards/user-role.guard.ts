import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class UserRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();

    const { user } = request;

    // userRole is set by jwt.strategy.ts from the platform's own user_role_mapping HOLDER row.
    // Not realm_access.roles: the 'holder' realm role is granted to every signup, so reading it
    // here would let anyone through -- and would make OrgRolesGuard/UserAccessGuard, which do the
    // inverse check on this same value, reject everyone.
    if (!user?.userRole) {
      throw new ForbiddenException('This role is not a holder.');
    }

    if (!user?.userRole.includes('holder')) {
      throw new ForbiddenException('This role is not a holder.');
    }

    return true;
  }
}
