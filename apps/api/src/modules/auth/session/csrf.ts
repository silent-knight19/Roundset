import crypto from 'node:crypto';
import type { SessionKeyring } from './keyring.js';
import type { ParsedCsrfToken } from './types.js';

export function generateCsrfNonce(): string {
  // >= 128 bits (16 bytes)
  return crypto.randomBytes(16).toString('base64url');
}

export function computeCsrfMac(
  hmacKey: Buffer,
  version: string,
  kid: string,
  sid: string,
  nonce: string
): string {
  const payload = `${version}:${kid}:${sid}:${nonce}`;
  return crypto.createHmac('sha256', hmacKey).update(payload).digest('base64url');
}

export function createCsrfToken(
  keyring: SessionKeyring,
  params: {
    sessionId: string;
    kid?: string;
  }
): string {
  const kid = params.kid ?? keyring.getActiveCsrfKid();
  const hmacKey = keyring.getCsrfHmacKey(kid);
  if (!hmacKey) {
    throw new Error(`CSRF HMAC key missing for kid: ${kid}`);
  }

  const nonce = generateCsrfNonce();
  const version = 'c1';
  const mac = computeCsrfMac(hmacKey, version, kid, params.sessionId, nonce);

  return `${version}.${kid}.${params.sessionId}.${nonce}.${mac}`;
}

export function parseCsrfToken(rawToken: string): ParsedCsrfToken | null {
  if (!rawToken || typeof rawToken !== 'string') {
    return null;
  }

  const parts = rawToken.split('.');
  if (parts.length !== 5) {
    return null;
  }

  const [version, kid, sid, nonce, mac] = parts;

  if (version !== 'c1') {
    return null;
  }

  if (!kid || !sid || !nonce || !mac) {
    return null;
  }

  const nonceBuf = Buffer.from(nonce, 'base64url');
  if (nonceBuf.length < 16) {
    return null;
  }

  return {
    raw: rawToken,
    version: 'c1',
    kid,
    sid,
    nonce,
    mac,
  };
}

export function verifyCsrfTokenMac(
  keyring: SessionKeyring,
  parsed: ParsedCsrfToken
): boolean {
  const hmacKey = keyring.getCsrfHmacKey(parsed.kid);
  if (!hmacKey) {
    return false;
  }

  const expectedMac = computeCsrfMac(
    hmacKey,
    parsed.version,
    parsed.kid,
    parsed.sid,
    parsed.nonce
  );

  const expectedBuf = Buffer.from(expectedMac, 'utf-8');
  const actualBuf = Buffer.from(parsed.mac, 'utf-8');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

export function verifyCsrfRequest(
  keyring: SessionKeyring,
  headerValue: string | undefined,
  cookieValue: string | undefined,
  expectedSessionId: string
): boolean {
  if (!headerValue || !cookieValue) {
    return false;
  }

  // 1. Constant-time equality between header and cookie values
  const headerBuf = Buffer.from(headerValue, 'utf-8');
  const cookieBuf = Buffer.from(cookieValue, 'utf-8');

  if (headerBuf.length !== cookieBuf.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(headerBuf, cookieBuf)) {
    return false;
  }

  // 2. Parse token format
  const parsed = parseCsrfToken(headerValue);
  if (!parsed) {
    return false;
  }

  // 3. Cryptographically verify MAC with keyring
  if (!verifyCsrfTokenMac(keyring, parsed)) {
    return false;
  }

  // 4. Verify session binding
  return parsed.sid === expectedSessionId;
}
