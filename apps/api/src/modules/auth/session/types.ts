export interface AccessTokenPayload {
  sub: string;
  sid: string;
  epoch: number;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface ParsedRefreshToken {
  raw: string;
  version: 'r1';
  kid: string;
  sid: string;
  generation: number;
  secret: string;
  mac: string;
}

export interface ParsedCsrfToken {
  raw: string;
  version: 'c1';
  kid: string;
  sid: string;
  nonce: string;
  mac: string;
}

export interface SessionLifetimes {
  idleTtlMs: number;
  absoluteTtlMs: number;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}
