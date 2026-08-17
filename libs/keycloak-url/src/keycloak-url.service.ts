import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class KeycloakUrlService {
  private readonly logger = new Logger('KeycloakUrlService');

  async createUserURL(realm: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/users`;
  }

  async getUserByUsernameURL(realm: string, username: string): Promise<string> {
    // exact=true: Keycloak's admin user search treats a bare ?username= as a case-insensitive
    // *partial* match by default, with unspecified result ordering. Every caller here takes
    // result[0].id and resets that user's password / links a new platform row to that Keycloak
    // account -- without exact=true, a new signup (e.g. 'bob') whose username happens to be a
    // prefix of an existing user's ('bob123') can silently reset bob123's password and adopt
    // their Keycloak account instead of its own. See the #71 review.
    //
    // encodeURIComponent on both segments: unencoded, a '#' anywhere in username truncates the
    // URL at a fragment, which axios never sends -- silently dropping &exact=true along with it.
    // Keycloak's default username-prohibited-characters validator doesn't reject '#', so this is
    // reachable with an ordinary-looking username. A username of just '#' turns this into
    // Keycloak's list-every-user-in-the-realm call, and every caller here resets the password of
    // (or links a platform account to) whichever record comes back at index 0 -- an
    // unauthenticated account-takeover primitive via the username-based signup flow. See the #71
    // review's escalation to this being worse than the prefix-match bug the exact=true fix above
    // was meant to close.
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${encodeURIComponent(realm)}/users?username=${encodeURIComponent(username)}&exact=true`;
  }

  async GetUserInfoURL(realm: string, userid: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/users/${userid}`;
  }

  async GetSATURL(realm: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}realms/${realm}/protocol/openid-connect/token`;
  }

  async ResetPasswordURL(realm: string, userid: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/users/${userid}/reset-password`;
  }

  async CreateRealmURL(): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms`;
  }

  async createClientURL(realm: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients`;
  }

  async GetClientURL(realm: string, clientid: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients?clientId=${clientid}`;
  }

  async GetClientSecretURL(realm: string, clientid: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients/${clientid}/client-secret`;
  }

  async GetClientRoleURL(realm: string, clientid: string, roleName = ''): Promise<string> {
    if ('' === roleName) {
      return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients/${clientid}/roles`;
    }

    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients/${clientid}/roles/${roleName}`;
  }

  async GetRealmRoleURL(realm: string, roleName = ''): Promise<string> {
    if ('' === roleName) {
      return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/roles`;
    }

    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/roles/${roleName}`;
  }

  async GetClientUserRoleURL(realm: string, userId: string, clientId?: string): Promise<string> {
    if (clientId) {
      return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/users/${userId}/role-mappings/clients/${clientId}`;
    }

    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/users/${userId}/role-mappings/realm`;
  }

  async GetClientIdpURL(realm: string, idp: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients/${idp}`;
  }

  async GetClient(realm: string, clientId: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients?clientId=${clientId}`;
  }
  async GetServiceAccountUserURL(realm: string, clientIdpId: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients/${clientIdpId}/service-account-user`;
  }

  async GetClientProtocolMappersURL(realm: string, clientIdpId: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients/${clientIdpId}/protocol-mappers/models`;
  }

  async GetClientScopesURL(realm: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/client-scopes`;
  }

  async GetClientScopeProtocolMappersURL(realm: string, scopeId: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/client-scopes/${scopeId}/protocol-mappers/models`;
  }

  async GetClientProtocolMappersByIdURL(realm: string, clientIdpId: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients/${clientIdpId}/protocol-mappers/models`;
  }

  async GetClientsURL(realm: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/clients?max=1000`;
  }

  async GetUserProfileURL(realm: string): Promise<string> {
    return `${process.env.KEYCLOAK_DOMAIN}admin/realms/${realm}/users/profile`;
  }
}
