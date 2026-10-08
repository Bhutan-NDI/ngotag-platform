/* eslint-disable camelcase */
/**
 * Regression tests for the holder marker (PR review): userRole is derived from the platform's own
 * user_role_mapping HOLDER row, and must stay authoritative over any userRole claim a token might
 * carry -- in both directions. Replaces the earlier tolerateKeycloakLookupMiss cases; that helper
 * and both Keycloak attribute lookups are gone, since user_role_mapping arrives with the user row.
 *
 * Constructed directly rather than via Nest's TestingModule/DI container -- only usersService is
 * exercised by these cases, and payloads are shaped to skip the session/org branches entirely
 * (no sid, no client_id) so those dependencies never need to be faked beyond a stub.
 */
import { CommonConstants } from '@credebl/common/common.constant';
import { JwtStrategy } from './jwt.strategy';
import { UserRole } from '@credebl/enum/enum';

function makeStrategy(userRow: Record<string, unknown>): JwtStrategy {
  const usersService = { findUserinKeycloak: jest.fn(async () => userRow) };
  return new JwtStrategy(usersService as never, {} as never, {} as never);
}

const holderRow = { id: 'user-1', user_role_mapping: [{ user_role: { role: UserRole.HOLDER } }] };
const nonHolderRow = { id: 'user-2', user_role_mapping: [] };

describe('JwtStrategy.validate — holder marker', () => {
  it('sets userRole from a HOLDER mapping', async () => {
    const result = await makeStrategy(holderRow).validate({ sub: 'keycloak-1' } as never);

    expect(result['userRole']).toBe(CommonConstants.USER_HOLDER_ROLE);
  });

  it('leaves userRole unset when there is no HOLDER mapping', async () => {
    const result = await makeStrategy(nonHolderRow).validate({ sub: 'keycloak-2' } as never);

    expect(result['userRole']).toBeUndefined();
  });

  it('does not let a token userRole claim elevate a non-holder', async () => {
    const result = await makeStrategy(nonHolderRow).validate({
      sub: 'keycloak-2',
      userRole: CommonConstants.USER_HOLDER_ROLE
    } as never);

    expect(result['userRole']).toBeUndefined();
  });

  it('does not let a token userRole claim mask a mapped holder', async () => {
    const result = await makeStrategy(holderRow).validate({
      sub: 'keycloak-1',
      userRole: 'not-a-holder'
    } as never);

    expect(result['userRole']).toBe(CommonConstants.USER_HOLDER_ROLE);
  });

  it('does not leak the raw mapping rows onto the request user', async () => {
    const result = await makeStrategy(holderRow).validate({ sub: 'keycloak-1' } as never);

    expect(result).not.toHaveProperty('user_role_mapping');
  });
});
