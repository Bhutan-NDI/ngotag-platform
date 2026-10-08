import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../authz/decorators/roles.decorator';
import { CloudWalletController } from '../cloud-wallet.controller';

// Regression test for the #71 review's authorization-gap finding: both endpoints previously only
// had AuthGuard('jwt'), reachable by any authenticated holder. Asserts the actual reflected
// metadata so a future refactor that silently drops the decorators still fails this test.
//
// Compares against the literal 'platform_admin' / 'OrgRolesGuard' rather than importing
// OrgRoles/OrgRolesGuard directly: this branch predates develop's libs/org-roles/enums jest
// moduleNameMapper fix (landed via #76) and hasn't rebased past it yet.
describe('CloudWalletController -- base-wallet admin endpoints require PLATFORM_ADMIN', () => {
  it.each(['getBaseWalletDetails', 'updateBaseWalletDetails'] as const)(
    '%s is guarded by OrgRolesGuard and requires PLATFORM_ADMIN',
    (methodName) => {
      const handler = CloudWalletController.prototype[methodName];

      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['platform_admin']);
      expect(
        (Reflect.getMetadata(GUARDS_METADATA, handler) as { name: string }[]).some((g) => 'OrgRolesGuard' === g.name)
      ).toBe(true);
    }
  );
});
