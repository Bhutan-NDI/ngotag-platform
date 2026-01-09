export interface JwtPayload {
  iss: string;
  sub: string;
  aud: string[];
  iat?: number;
  exp?: number;
  azp: string;
  scope: string;
  gty?: string;
  permissions: string[];
  email?: string;
  sid: string;
  preferred_username: string;
  client_id: string;
}
