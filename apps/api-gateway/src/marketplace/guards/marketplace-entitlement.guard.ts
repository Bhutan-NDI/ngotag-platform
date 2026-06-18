import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MARKETPLACE_FEATURE_KEY, MarketplaceFeature } from '../decorators/requires-marketplace-feature.decorator';
import { MarketplaceService } from '../marketplace.service';
import { OrgRoles } from 'libs/org-roles/enums';

interface EntitlementResponse {
  features?: Record<string, boolean>;
  blockedReason?: string | null;
  usage?: Record<string, { included: number; used: number; overage: number }>;
}

interface MarketplaceRequestUser {
  id?: string;
  email?: string;
  userOrgRoles?: { orgRole?: { name?: string } }[];
}

@Injectable()
export class MarketplaceEntitlementGuard implements CanActivate {
  private readonly logger = new Logger(MarketplaceEntitlementGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly marketplaceService: MarketplaceService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<MarketplaceFeature>(MARKETPLACE_FEATURE_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!feature) {
      return true;
    }

    // When marketplace billing is globally disabled, do not enforce entitlements and
    // do not couple core SSI flows to the availability of the marketplace microservice.
    if ('true' !== `${process.env.MARKETPLACE_ENABLED}`.toLowerCase()) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    if (this.isPlatformAdmin(request.user)) {
      return true;
    }

    const orgId = this.getOrgId(request);

    if (!orgId) {
      return true;
    }

    const marketplaceRequired = 'true' === `${process.env.MARKETPLACE_REQUIRED}`.toLowerCase();

    let entitlements: EntitlementResponse;
    try {
      entitlements = (await this.marketplaceService.getEntitlements(orgId, request.user?.id)) as EntitlementResponse;
    } catch (error) {
      this.logger.warn(
        `Marketplace entitlement check failed for org ${orgId}: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`
      );
      // Fail-open unless marketplace is mandatory, so a marketplace/NATS outage does not block issuance/verification.
      if (marketplaceRequired) {
        throw new ForbiddenException({
          code: 'marketplace_entitlement_unavailable',
          message: 'Unable to verify Marketplace entitlements'
        });
      }
      return true;
    }

    if (entitlements.features?.[feature]) {
      if ('schemaCreate' === feature && this.isUsageLimitReached(entitlements, 'schema_create')) {
        throw new ForbiddenException({
          code: 'marketplace_schema_limit_reached',
          message: 'Marketplace schema creation limit has been reached for this plan'
        });
      }
      if (
        ('issuance' === feature || 'bulkIssuance' === feature) &&
        this.isUsageLimitReached(entitlements, 'issuance_txn')
      ) {
        throw new ForbiddenException({
          code: 'marketplace_issuance_limit_reached',
          message: 'Marketplace issuance transaction limit has been reached for this plan'
        });
      }
      if ('verification' === feature && this.isUsageLimitReached(entitlements, 'verification_txn')) {
        throw new ForbiddenException({
          code: 'marketplace_verification_limit_reached',
          message: 'Marketplace verification transaction limit has been reached for this plan'
        });
      }
      return true;
    }

    throw new ForbiddenException({
      code: entitlements.blockedReason || 'marketplace_feature_not_allowed',
      message: 'Marketplace subscription does not allow this action'
    });
  }

  private isPlatformAdmin(user: MarketplaceRequestUser | undefined): boolean {
    if (!user) {
      return false;
    }

    const platformAdminEmail = process.env.PLATFORM_ADMIN_EMAIL;
    if (platformAdminEmail && user.email === platformAdminEmail) {
      return true;
    }

    return Boolean(
      Array.isArray(user.userOrgRoles) &&
      user.userOrgRoles.some((orgDetails) => orgDetails?.orgRole?.name === OrgRoles.PLATFORM_ADMIN)
    );
  }

  private isUsageLimitReached(entitlements: EntitlementResponse, dimension: string): boolean {
    const usage = entitlements.usage?.[dimension];
    if (!usage || null === usage.included || usage.included === undefined) {
      return false;
    }

    return Number(usage.used || 0) >= Number(usage.included);
  }

  private getOrgId(request): string | undefined {
    return (
      request.params?.orgId ||
      request.params?.organizationId ||
      request.body?.orgId ||
      request.body?.organizationId ||
      request.query?.orgId
    );
  }
}
