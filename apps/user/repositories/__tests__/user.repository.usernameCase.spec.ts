/**
 * Regression test — #71 review: username was persisted verbatim (not lowercased), even though
 * Keycloak lowercases usernames on create (KeycloakModelUtils.toLowerCaseSafe) and a JWT's
 * preferred_username claim is therefore always lowercase. A user who signed up with a mixed-case
 * username could log in, but every subsequent lookup by the token's lowercased preferred_username
 * (jwt.strategy -> getUserByUsernameInKeycloak -> checkUserExistByUsername) found no row and
 * silently 403'd with "not a holder" -- permanently, since the mismatch never resolves on its own.
 * Fixed by lowercasing on both write (createUserByUsername) and read
 * (checkUserExistByUsername), matching the email flow's existing userInfo.email.toLowerCase()
 * pattern.
 *
 * Constructed directly (not via Nest's TestingModule/DI container) — PrismaService is trivial to
 * fake for these two methods.
 */
import { UserRepository } from '../user.repository';

describe('UserRepository — username case normalization', () => {
  it('checkUserExistByUsername looks up a lowercased username, regardless of the case supplied', async () => {
    const findFirst = jest.fn(async () => ({ id: 'user-1', username: 'alice' }));
    const prisma = { user: { findFirst } };
    const logger = { error: jest.fn() };
    const repository = new UserRepository(prisma as never, logger as never);

    await repository.checkUserExistByUsername('Alice');

    expect(findFirst).toHaveBeenCalledWith({ where: { username: 'alice' } });
  });

  it('createUserByUsername persists a lowercased username, regardless of the case the caller signed up with', async () => {
    const create = jest.fn(async (args: { data: { username: string } }) => ({ id: 'user-1', ...args.data }));
    const prisma = { user: { create } };
    const logger = { error: jest.fn() };
    const repository = new UserRepository(prisma as never, logger as never);

    await repository.createUserByUsername(
      {
        username: 'Alice',
        firstName: 'Alice',
        lastName: 'Holder',
        clientId: 'client-1',
        clientSecret: 'secret'
      },
      'keycloak-user-1'
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ username: 'alice' }) })
    );
  });

  it('createUserByUsername persists the given email', async () => {
    const create = jest.fn(async (args: { data: { username: string } }) => ({ id: 'user-1', ...args.data }));
    const prisma = { user: { create } };
    const logger = { error: jest.fn() };
    const repository = new UserRepository(prisma as never, logger as never);

    await repository.createUserByUsername(
      {
        username: 'alice',
        firstName: 'Alice',
        lastName: 'Holder',
        clientId: 'client-1',
        clientSecret: 'secret',
        email: 'alice@example.com'
      },
      'keycloak-user-1'
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'alice@example.com' }) })
    );
  });

  it('createUserByUsername lowercases the given email, regardless of the case it arrives in', async () => {
    const create = jest.fn(async (args: { data: { username: string } }) => ({ id: 'user-1', ...args.data }));
    const prisma = { user: { create } };
    const logger = { error: jest.fn() };
    const repository = new UserRepository(prisma as never, logger as never);

    await repository.createUserByUsername(
      {
        username: 'alice',
        firstName: 'Alice',
        lastName: 'Holder',
        clientId: 'client-1',
        clientSecret: 'secret',
        email: 'Alice@Example.com'
      },
      'keycloak-user-1'
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'alice@example.com' }) })
    );
  });
});
