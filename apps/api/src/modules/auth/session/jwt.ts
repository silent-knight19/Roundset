import crypto from 'node:crypto';
import * as jose from 'jose';
import type { SessionKeyring } from './keyring.js';
import type { AccessTokenPayload } from './types.js';
import { UnauthorizedError } from '../../../core/errors.js';

export const ACCESS_TOKEN_TTL_SECONDS = 600; // 10 minutes

export async function signAccessToken(
  keyring: SessionKeyring,
  params: { userId: string; sessionId: string; epoch: number }
): Promise<string> {
  await keyring.ensureInitialized();
  const { kid, key } = keyring.getJwtSigningKey();
  const jti = crypto.randomUUID();

  return await new jose.SignJWT({
    sid: params.sessionId,
    epoch: params.epoch,
  })
    .setSubject(params.userId)
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuer(keyring.jwtIssuer)
    .setAudience(keyring.jwtAudience)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyAccessToken(
  keyring: SessionKeyring,
  token: string
): Promise<AccessTokenPayload> {
  if (!token || typeof token !== 'string') {
    throw new UnauthorizedError('Access token is required');
  }

  await keyring.ensureInitialized();

  // 1. Decode protected header without verification to extract kid and alg
  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(token);
  } catch {
    throw new UnauthorizedError('Malformed access token header');
  }

  if (header.alg !== 'EdDSA') {
    throw new UnauthorizedError('Invalid access token algorithm');
  }

  if (!header.kid) {
    throw new UnauthorizedError('Missing access token key ID (kid)');
  }

  // 2. Fetch public key corresponding to kid from keyring
  const publicKey = keyring.getJwtVerificationKey(header.kid);
  if (!publicKey) {
    throw new UnauthorizedError(`Unknown access token key ID: ${header.kid}`);
  }

  // 3. Cryptographically verify signature, issuer, audience, and exp
  let result: jose.JWTVerifyResult;
  try {
    result = await jose.jwtVerify(token, publicKey, {
      issuer: keyring.jwtIssuer,
      audience: keyring.jwtAudience,
      algorithms: ['EdDSA'],
      clockTolerance: '30s',
    });
  } catch (err: unknown) {
    const errorObj = err as { code?: string; message?: string };
    if (errorObj.code === 'ERR_JWT_EXPIRED') {
      throw new UnauthorizedError('Access token has expired');
    }
    throw new UnauthorizedError('Access token signature verification failed');
  }

  const { payload } = result;

  // 4. Validate required claims: sub, sid, jti, iat, exp, epoch
  if (
    !payload.sub ||
    typeof payload.sub !== 'string' ||
    !payload.sid ||
    typeof payload.sid !== 'string' ||
    typeof payload.epoch !== 'number' ||
    !payload.jti ||
    typeof payload.jti !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    typeof payload.iss !== 'string' ||
    (typeof payload.aud !== 'string' && !Array.isArray(payload.aud))
  ) {
    throw new UnauthorizedError('Access token contains malformed or missing claims');
  }

  const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (!audience || typeof audience !== 'string') {
    throw new UnauthorizedError('Access token contains malformed or missing audience');
  }

  return {
    sub: payload.sub,
    sid: payload.sid,
    epoch: payload.epoch,
    jti: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
    iss: payload.iss,
    aud: audience,
  };
}
