import { OrgRoles } from 'libs/org-roles/enums';

export interface MarketplaceRequestUser {
  id?: string;
  email?: string;
  userOrgRoles?: { orgRole?: { name?: string } }[];
}

export const PLATFORM_ADMIN_ENTITLEMENTS = {
  features: {
    schemaCreate: true,
    credentialDefinitionCreate: true,
    issuance: true,
    bulkIssuance: true,
    verification: true,
    apiAccess: true
  },
  limits: {},
  usage: {},
  blockedReason: null
};

export function isPlatformAdmin(user: MarketplaceRequestUser | undefined): boolean {
  if (!user) {
    return false;
  }

  return Boolean(
    Array.isArray(user.userOrgRoles) &&
    user.userOrgRoles.some((orgDetails) => orgDetails?.orgRole?.name === OrgRoles.PLATFORM_ADMIN)
  );
}
