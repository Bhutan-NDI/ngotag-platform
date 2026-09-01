/* eslint-disable camelcase */
/**
 * Regression tests for tolerateKeycloakLookupMiss's narrowing (PR review): a genuine "not found"
 * from the email lookup should fall through to preferred_username, but any other error (Keycloak
 * admin API down, NATS failure) should surface instead of silently degrading auth.
 *
 * Constructed directly rather than via Nest's TestingModule/DI container -- only usersService is
 * exercised by these cases, and payloads are shaped to skip the session/org branches entirely
 * (no sid, no client_id) so those dependencies never need to be faked beyond a stub.
 */
import { NotFoundException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { ResponseMessages } from '@credebl/common/response-messages';

function makeStrategy(usersService: Record<string, jest.Mock>): JwtStrategy {
  return new JwtStrategy(usersService as never, {} as never, {} as never);
}

describe('JwtStrategy.validate — tolerateKeycloakLookupMiss', () => {
  it('falls through to preferred_username when the email lookup genuinely misses', async () => {
    const usersService = {
      getUserByUserIdInKeycloak: jest.fn(async () => {
        throw new NotFoundException(ResponseMessages.user.error.notFound);
      }),
      getUserByUsernameInKeycloak: jest.fn(async () => ({ attributes: {} })),
      findUserinKeycloak: jest.fn(async () => ({ id: 'user-1' }))
    };
    const strategy = makeStrategy(usersService);

    await strategy.validate({ email: 'alice@example.com', preferred_username: 'alice' } as never);

    expect(usersService.getUserByUsernameInKeycloak).toHaveBeenCalledWith('alice');
  });

  it('does not swallow a non-"not found" error from the email lookup', async () => {
    const usersService = {
      getUserByUserIdInKeycloak: jest.fn(async () => {
        throw new Error('Keycloak admin API unreachable');
      }),
      getUserByUsernameInKeycloak: jest.fn(),
      findUserinKeycloak: jest.fn(async () => ({ id: 'user-1' }))
    };
    const strategy = makeStrategy(usersService);

    await expect(
      strategy.validate({ email: 'alice@example.com', preferred_username: 'alice' } as never)
    ).rejects.toThrow('Keycloak admin API unreachable');
    expect(usersService.getUserByUsernameInKeycloak).not.toHaveBeenCalled();
  });
});
