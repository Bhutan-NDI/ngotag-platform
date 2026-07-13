import { ExecutionContext, ForbiddenException } from '@nestjs/common';

jest.mock('../marketplace.service', () => ({
  MarketplaceService: jest.fn()
}));

import { MarketplaceEntitlementGuard } from './marketplace-entitlement.guard';

describe('MarketplaceEntitlementGuard', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';

  const createContext = (): ExecutionContext =>
    ({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn(() => ({
        getRequest: jest.fn(() => ({
          params: { orgId },
          user: { id: 'user-id' }
        }))
      }))
    }) as unknown as ExecutionContext;

  const createGuard = (feature: string, entitlements: object): MarketplaceEntitlementGuard => {
    const reflector = {
      getAllAndOverride: jest.fn(() => feature)
    };
    const marketplaceService = {
      getEntitlements: jest.fn(() => Promise.resolve(entitlements))
    };

    return new MarketplaceEntitlementGuard(reflector as never, marketplaceService as never);
  };

  it('allows schema creation while schema usage is below the plan limit', async () => {
    const guard = createGuard('schemaCreate', {
      features: { schemaCreate: true },
      usage: { schema_create: { included: 5, used: 4, overage: 0 } }
    });

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
  });

  it('blocks schema creation when schema usage reaches the plan limit', async () => {
    const guard = createGuard('schemaCreate', {
      features: { schemaCreate: true },
      usage: { schema_create: { included: 1, used: 1, overage: 0 } }
    });

    await expect(guard.canActivate(createContext())).rejects.toThrow(ForbiddenException);
  });

  it('does not apply the schema hard limit to other marketplace features', async () => {
    const guard = createGuard('issuance', {
      features: { issuance: true },
      usage: { issuance_txn: { included: 100, used: 100, overage: 0 } }
    });

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
  });
});
