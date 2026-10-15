import { BadRequestException, ForbiddenException } from '@nestjs/common';

interface UserOrgRole {
  orgId: string;
}

// mobile-verifier has no organization table of its own — it resolves org identity and
// permissions directly against the ngotag platform's own organisation + Keycloak client
// roles. A user can belong to more than one org, so the caller must say which org they're
// acting as (orgId) rather than it being inferred; this cross-checks that org against the
// JWT's `userOrgRoles` claim, the same way apps/api-gateway/src/authz/guards/org-roles.guard.ts
// validates org-scoped access elsewhere on the platform.
export const resolveNgotagOrgId = (
  user: Record<string, unknown> | undefined,
  requestedOrgId: string | undefined
): string => {
  if (!requestedOrgId) {
    throw new BadRequestException('orgId is required');
  }

  const userOrgRoles = (user?.userOrgRoles ?? []) as UserOrgRole[];
  const isMember = userOrgRoles.some((membership) => membership.orgId === requestedOrgId);

  if (!isMember) {
    throw new ForbiddenException('You are not a member of this organization');
  }

  return requestedOrgId;
};
