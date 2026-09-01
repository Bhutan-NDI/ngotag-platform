/**
 * Regression tests for the account-takeover fix in ClientRegistrationService's Keycloak
 * user-lookup callers (createUserByUsername/createUser/resetPasswordOfUser). See the #71 review:
 * these methods used to trust getUserResponse[0].id unconditionally -- combined with the
 * URL-encoding bug in KeycloakUrlService.getUserByUsernameURL (fixed separately), that let an
 * attacker's lookup resolve to an arbitrary existing Keycloak user, whose password the code then
 * reset to an attacker-supplied value. findMatchingKeycloakUser now requires the returned record's
 * own username to actually equal the one that was looked up before any password is reset or any
 * keycloakUserId is handed back -- these tests model a lookup response where index 0 is NOT the
 * intended user, which the pre-fix code would have silently acted on.
 *
 * Constructed directly (not via Nest's TestingModule/DI container): ClientRegistrationService's
 * real dependency chain pulls in CommonService, which pulls in @sendgrid/mail and initializes a
 * real SendGrid client at import time -- unrelated to what's under test here, and unnecessary
 * since both of this service's real dependencies (CommonService, KeycloakUrlService) are trivial
 * to fake directly.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientRegistrationService } from './client-registration.service';

const REALM = 'test-realm';
const TOKEN = 'test-token';

function makeService(getUserResponse: unknown): {
  service: ClientRegistrationService;
  commonService: { httpGet: jest.Mock; httpPost: jest.Mock; httpPut: jest.Mock };
  keycloakUrlService: { createUserURL: jest.Mock; getUserByUsernameURL: jest.Mock; ResetPasswordURL: jest.Mock };
} {
  const commonService = {
    httpGet: jest.fn(async () => getUserResponse),
    httpPost: jest.fn(async () => ({})),
    httpPut: jest.fn(async () => ({}))
  };
  const keycloakUrlService = {
    createUserURL: jest.fn(async () => 'https://keycloak.example.com/create'),
    getUserByUsernameURL: jest.fn(
      async (realm: string, username: string) =>
        `https://keycloak.example.com/users?username=${username}&realm=${realm}`
    ),
    ResetPasswordURL: jest.fn(async (realm: string, userid: string) => `https://keycloak.example.com/${userid}/reset`)
  };
  const service = new ClientRegistrationService(commonService as never, keycloakUrlService as never);
  return { service, commonService, keycloakUrlService };
}

describe('ClientRegistrationService — Keycloak lookup response is not trusted at index 0 blindly', () => {
  describe('createUserByUsername', () => {
    it('resets the password of the user whose own username matches, not whichever record came back first', async () => {
      // Models the exploit scenario directly: the lookup response's first entry is an unrelated
      // account. Pre-fix, getUserResponse[0].id would have been used for both the password reset
      // and the returned keycloakUserId -- silently acting on "someone-else" instead of "alice".
      const { service, keycloakUrlService } = makeService([
        { id: 'victim-id', username: 'someone-else' },
        { id: 'correct-id', username: 'alice' }
      ]);

      const result = await service.createUserByUsername(
        { username: 'alice', password: 'attacker-chosen-password' } as never,
        REALM,
        TOKEN
      );

      expect(result.keycloakUserId).toBe('correct-id');
      expect(keycloakUrlService.ResetPasswordURL).toHaveBeenCalledWith(REALM, 'correct-id');
      expect(keycloakUrlService.ResetPasswordURL).not.toHaveBeenCalledWith(REALM, 'victim-id');
    });

    it('throws instead of silently resetting an unrelated account when no returned user matches', async () => {
      const { service, keycloakUrlService } = makeService([{ id: 'unrelated-id', username: 'someone-else' }]);

      await expect(
        service.createUserByUsername({ username: 'alice', password: 'x' } as never, REALM, TOKEN)
      ).rejects.toThrow(NotFoundException);
      expect(keycloakUrlService.ResetPasswordURL).not.toHaveBeenCalled();
    });

    it('sets emailVerified: true and a per-user placeholder email, not one shared literal', async () => {
      const oldEmail = process.env.CLOUD_WALLET_EMAIL_DOMAIN;
      process.env.CLOUD_WALLET_EMAIL_DOMAIN = 'example.com';
      try {
        const { service, commonService } = makeService([{ id: 'correct-id', username: 'alice' }]);

        await service.createUserByUsername({ username: 'alice', password: 'x' } as never, REALM, TOKEN);

        const payload = commonService.httpPost.mock.calls[0][1] as Record<string, unknown>;
        expect(payload.emailVerified).toBe(true);
        expect(payload.email).toBe('alice@example.com');
      } finally {
        process.env.CLOUD_WALLET_EMAIL_DOMAIN = oldEmail;
      }
    });

    it('lowercases the placeholder email, matching the read-side checkUserExist lookup', async () => {
      const oldEmail = process.env.CLOUD_WALLET_EMAIL_DOMAIN;
      process.env.CLOUD_WALLET_EMAIL_DOMAIN = 'example.com';
      try {
        const { service, commonService } = makeService([{ id: 'correct-id', username: 'AliceHolder' }]);

        const result = await service.createUserByUsername(
          { username: 'AliceHolder', password: 'x' } as never,
          REALM,
          TOKEN
        );

        const payload = commonService.httpPost.mock.calls[0][1] as Record<string, unknown>;
        expect(payload.email).toBe('aliceholder@example.com');
        expect(result.email).toBe('aliceholder@example.com');
      } finally {
        process.env.CLOUD_WALLET_EMAIL_DOMAIN = oldEmail;
      }
    });

    it('returns the same email it set on the Keycloak user, for callers to persist locally', async () => {
      const oldEmail = process.env.CLOUD_WALLET_EMAIL_DOMAIN;
      process.env.CLOUD_WALLET_EMAIL_DOMAIN = 'example.com';
      try {
        const { service } = makeService([{ id: 'correct-id', username: 'alice' }]);

        const result = await service.createUserByUsername({ username: 'alice', password: 'x' } as never, REALM, TOKEN);

        expect(result.email).toBe('alice@example.com');
      } finally {
        process.env.CLOUD_WALLET_EMAIL_DOMAIN = oldEmail;
      }
    });

    it('rejects a username unsafe as an email local-part instead of building a malformed placeholder', async () => {
      const { service, commonService } = makeService([{ id: 'correct-id', username: 'al ice@x' }]);

      await expect(
        service.createUserByUsername({ username: 'al ice@x', password: 'x' } as never, REALM, TOKEN)
      ).rejects.toThrow(BadRequestException);
      expect(commonService.httpPost).not.toHaveBeenCalled();
    });

    // AddUserDetailsUsernameBasedDto (the only DTO that reaches this method in production) has no
    // email field, so this branch isn't reachable today -- kept for whenever a real caller does.
    it('uses the caller-supplied email over the placeholder when one is given', async () => {
      const { service, commonService } = makeService([{ id: 'correct-id', username: 'alice' }]);

      await service.createUserByUsername(
        { username: 'alice', password: 'x', email: 'real@example.com' } as never,
        REALM,
        TOKEN
      );

      const payload = commonService.httpPost.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.email).toBe('real@example.com');
    });
  });

  describe('createUser', () => {
    it('resets the password of the user whose own username matches, not whichever record came back first', async () => {
      const { service, keycloakUrlService } = makeService([
        { id: 'victim-id', username: 'someone-else@example.com' },
        { id: 'correct-id', username: 'alice@example.com' }
      ]);

      const result = await service.createUser(
        { email: 'alice@example.com', password: 'attacker-chosen-password' } as never,
        REALM,
        TOKEN
      );

      expect(result.keycloakUserId).toBe('correct-id');
      expect(keycloakUrlService.ResetPasswordURL).toHaveBeenCalledWith(REALM, 'correct-id');
    });

    it('throws instead of silently resetting an unrelated account when no returned user matches', async () => {
      const { service } = makeService([{ id: 'unrelated-id', username: 'someone-else@example.com' }]);

      await expect(
        service.createUser({ email: 'alice@example.com', password: 'x' } as never, REALM, TOKEN)
      ).rejects.toThrow(NotFoundException);
    });

    it("matches a mixed-case email against Keycloak's own lowercased username -- #73 review: signup used to 404 here, after the Keycloak account already existed", async () => {
      // Keycloak lowercases usernames on create (KeycloakModelUtils.toLowerCaseSafe), but the
      // request body's raw email/username is passed through unchanged -- an exact `===` match
      // against a mixed-case expectedUsername never matched the lowercased record, so this threw
      // invalidKeycloakId for every mixed-case signup, after the Keycloak user had already been
      // created and before its password was ever set.
      const { service, keycloakUrlService } = makeService([{ id: 'correct-id', username: 'alice@example.com' }]);

      const result = await service.createUser(
        { email: 'Alice@Example.com', password: 'attacker-chosen-password' } as never,
        REALM,
        TOKEN
      );

      expect(result.keycloakUserId).toBe('correct-id');
      expect(keycloakUrlService.ResetPasswordURL).toHaveBeenCalledWith(REALM, 'correct-id');
    });
  });

  describe('resetPasswordOfUser', () => {
    it('resets the password of the user whose own username matches, not whichever record came back first', async () => {
      const { service, keycloakUrlService } = makeService([
        { id: 'victim-id', username: 'someone-else@example.com' },
        { id: 'correct-id', username: 'alice@example.com' }
      ]);

      await service.resetPasswordOfUser(
        { email: 'alice@example.com', password: 'new-password' } as never,
        REALM,
        TOKEN
      );

      expect(keycloakUrlService.ResetPasswordURL).toHaveBeenCalledWith(REALM, 'correct-id');
      expect(keycloakUrlService.ResetPasswordURL).not.toHaveBeenCalledWith(REALM, 'victim-id');
    });

    it('throws instead of silently resetting an unrelated account when no returned user matches', async () => {
      const { service } = makeService([{ id: 'unrelated-id', username: 'someone-else@example.com' }]);

      await expect(
        service.resetPasswordOfUser({ email: 'alice@example.com', password: 'x' } as never, REALM, TOKEN)
      ).rejects.toThrow(NotFoundException);
    });
  });
});
