import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { isPlatformAdmin, MarketplaceRequestUser } from '../utils/platform-admin.util';

/**
 * Blocks standalone organization creation when the Microsoft Marketplace is the only
 * supported source of subscriptions. When enforced, the only supported way to create an
 * organization is through the Marketplace onboarding wizard (which links a resolved
 * subscription and creates the org over NATS, bypassing this gateway endpoint).
 *
 * No-op unless both MARKETPLACE_ENABLED and MARKETPLACE_REQUIRED are 'true', so the
 * default self-service flow is unchanged when marketplace billing is off or optional.
 * Platform admins always bypass so internal/admin org creation keeps working.
 */
@Injectable()
export class MarketplaceSubscriptionRequiredGuard implements CanActivate {
  private readonly logger = new Logger(MarketplaceSubscriptionRequiredGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const marketplaceEnabled = 'true' === `${process.env.MARKETPLACE_ENABLED}`.toLowerCase();
    const marketplaceRequired = 'true' === `${process.env.MARKETPLACE_REQUIRED}`.toLowerCase();

    if (!marketplaceEnabled || !marketplaceRequired) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: MarketplaceRequestUser }>();
    const { user } = request;

    if (isPlatformAdmin(user)) {
      return true;
    }

    this.logger.warn(
      `Blocked standalone organization creation for user ${user?.id || user?.email}: Marketplace subscription required`
    );

    throw new ForbiddenException({
      code: 'marketplace_subscription_required',
      message: 'Organizations can only be created through a Microsoft Marketplace subscription.'
    });
  }
}
