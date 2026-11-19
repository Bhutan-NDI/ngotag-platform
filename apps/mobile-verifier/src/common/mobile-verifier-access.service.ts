import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { OrgRoles } from 'libs/org-roles/enums';
import { PrismaService } from '@credebl/prisma-service';
import { getResourceRoles, getTokenSubject } from './keycloak-roles.util';

@Injectable()
export class MobileVerifierAccess {
  constructor(private readonly prismaService: PrismaService) {}

  // Passes when the caller holds one of the required roles in the org, or is a platform admin.
  // platform_admin lives in user_org_roles, never in the token, so it needs a DB lookup -- made
  // only when the token's own roles fall short.
  async assertRole(authorization: string | undefined, orgId: string, required: string | string[]): Promise<void> {
    const requiredList = Array.isArray(required) ? required : [required];
    const roles = getResourceRoles(authorization, orgId);
    if (requiredList.some((role) => roles.includes(role))) {
      return;
    }
    if (await this.isPlatformAdmin(authorization)) {
      return;
    }
    // NOTE: libs/http-exception.filter.ts only special-cases the exact HttpException class
    // (switch on exception.constructor), not its subclasses like ForbiddenException — those
    // fall through to a 500. Every other throw in this codebase uses `new HttpException(...)`
    // directly for exactly this reason.
    throw new HttpException(
      `Not authorized: missing required role (${requiredList.join(' or ')})`,
      HttpStatus.FORBIDDEN
    );
  }

  private async isPlatformAdmin(authorization: string | undefined): Promise<boolean> {
    const keycloakUserId = getTokenSubject(authorization);
    if (!keycloakUserId) {
      return false;
    }
    const count = await this.prismaService.user_org_roles.count({
      where: { user: { keycloakUserId }, orgRole: { name: OrgRoles.PLATFORM_ADMIN } }
    });
    return 0 < count;
  }
}
