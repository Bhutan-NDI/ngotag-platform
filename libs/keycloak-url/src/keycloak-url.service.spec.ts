/**
 * Regression test for getUserByUsernameURL's URL-encoding fix. See the #71 review: unencoded
 * interpolation let a '#' in the username truncate the URL at a fragment, silently dropping
 * &exact=true and turning "look up this one user" into Keycloak's list-every-user-in-the-realm
 * call -- with every caller in ClientRegistrationService then trusting whichever record came back
 * first, an unauthenticated account-takeover primitive via the username-based signup flow.
 */
import { KeycloakUrlService } from './keycloak-url.service';

describe('KeycloakUrlService.getUserByUsernameURL', () => {
  const ORIGINAL_ENV = process.env.KEYCLOAK_DOMAIN;
  let service: KeycloakUrlService;

  beforeAll(() => {
    process.env.KEYCLOAK_DOMAIN = 'https://keycloak.example.com/';
  });

  afterAll(() => {
    process.env.KEYCLOAK_DOMAIN = ORIGINAL_ENV;
  });

  beforeEach(() => {
    service = new KeycloakUrlService();
  });

  it('encodes a "#" in the username instead of letting it truncate the URL at a fragment', async () => {
    const url = await service.getUserByUsernameURL('test-realm', 'alice#malicious');

    // The whole point: '#' must not survive unencoded into the URL, since everything after an
    // unencoded '#' becomes a URI fragment that is never sent to the server -- which is exactly
    // what silently dropped &exact=true in the exploit this fixes.
    expect(url).not.toMatch(/username=alice#/);
    expect(url).toContain('username=alice%23malicious');
    expect(url.endsWith('&exact=true')).toBe(true);
  });

  it('encodes a bare "#" username (the "list every user" variant) the same way', async () => {
    const url = await service.getUserByUsernameURL('test-realm', '#');

    expect(url).toContain('username=%23');
    expect(url.endsWith('&exact=true')).toBe(true);
  });

  it('encodes "&" so it cannot inject additional query parameters', async () => {
    const url = await service.getUserByUsernameURL('test-realm', 'alice&admin=true');

    expect(url).toContain('username=alice%26admin%3Dtrue');
    // Only one &exact=true -- an unencoded '&' would have added a second, attacker-controlled
    // query parameter instead.
    expect(url.match(/&/g)?.length).toBe(1);
  });

  it('still produces the expected URL for an ordinary username, unchanged', async () => {
    const url = await service.getUserByUsernameURL('test-realm', 'alice');

    expect(url).toBe('https://keycloak.example.com/admin/realms/test-realm/users?username=alice&exact=true');
  });
});
