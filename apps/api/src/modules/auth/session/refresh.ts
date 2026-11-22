import crypto from 'node:crypto';
import type { SessionKeyring } from './keyring.js';
import type { ParsedRefreshToken } from './types.js';

export function generateRefreshSecret(): string {
  // >= 256 bits (32 bytes)
  return crypto.randomBytes(32).toString('base64url');
}

export function computeRefreshMac(
  integrityKey: Buffer,
  version: string,
  kid: string,
  sid: string,
  gen: number,
  secret: string
): string {
  const payload = `${version}:${kid}:${sid}:${gen}:${secret}`;
  return crypto.createHmac('sha256', integrityKey).update(payload).digest('base64url');
}

export function computeRefreshDigest(digestKey: Buffer, rawToken: string): string {
  return crypto
    .createHmac('sha256', digestKey)
    .update(`digest:v1:${rawToken}`)
    .digest('hex');
}

export function createRefreshToken(
  keyring: SessionKeyring,
  params: {
    sessionId: string;
    generation: number;
    kid?: string;
  }
): { rawToken: string; secret: string; digest: string } {
  const kid = params.kid ?? keyring.getActiveRefreshKid();
  const integrityKey = keyring.getRefreshHmacKey(kid);
  const digestKey = keyring.getRefreshDigestKey(kid);

  if (!integrityKey || !digestKey) {
    throw new Error(`Refresh keys missing for kid: ${kid}`);
  }

  const secret = generateRefreshSecret();
  const version = 'r1';
  const mac = computeRefreshMac(integrityKey, version, kid, params.sessionId, params.generation, secret);
  const rawToken = `${version}.${kid}.${params.sessionId}.${params.generation}.${secret}.${mac}`;
  const digest = computeRefreshDigest(digestKey, rawToken);

  return { rawToken, secret, digest };
}

export function parseRefreshToken(rawToken: string): ParsedRefreshToken | null {
  if (!rawToken || typeof rawToken !== 'string') {
    return null;
  }

  const parts = rawToken.split('.');
  if (parts.length !== 6) {
    return null;
  }

  const [version, kid, sid, genStr, secret, mac] = parts;

  if (!version || !kid || !sid || !genStr || !secret || !mac) {
    return null;
  }

  if (version !== 'r1') {
    return null;
  }

  // Generation must be a positive integer
  if (!/^[1-9]\d*$/.test(genStr)) {
    return null;
  }

  const generation = parseInt(genStr, 10);

  // Secret must represent at least 256 bits (32 bytes)
  const secretBuffer = Buffer.from(secret, 'base64url');
  if (secretBuffer.length < 32) {
    return null;
  }

  return {
    raw: rawToken,
    version: 'r1',
    kid,
    sid,
    generation,
    secret,
    mac,
  };
}

export function verifyRefreshTokenMac(
  keyring: SessionKeyring,
  parsed: ParsedRefreshToken
): boolean {
  const integrityKey = keyring.getRefreshHmacKey(parsed.kid);
  if (!integrityKey) {
    return false;
  }

  const expectedMac = computeRefreshMac(
    integrityKey,
    parsed.version,
    parsed.kid,
    parsed.sid,
    parsed.generation,
    parsed.secret
  );

  const expectedBuf = Buffer.from(expectedMac, 'utf-8');
  const actualBuf = Buffer.from(parsed.mac, 'utf-8');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
