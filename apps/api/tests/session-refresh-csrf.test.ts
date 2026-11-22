import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
import {
  SessionKeyring,
  createRefreshToken,
  parseRefreshToken,
  verifyRefreshTokenMac,
  computeRefreshDigest,
  createCsrfToken,
  parseCsrfToken,
  verifyCsrfTokenMac,
  verifyCsrfRequest,
  computeSessionLifetimes,
  computeRemainingCookieTtlSeconds,
  serializeRefreshCookie,
  serializeCsrfCookie,
  serializeClearCookies,
  parseCookies,
  extractRefreshCookie,
  extractCsrfCookie,
  CANDIDATE_IDLE_TTL_SECONDS,
  CANDIDATE_ABSOLUTE_TTL_SECONDS,
  ADMIN_IDLE_TTL_SECONDS,
  ADMIN_ABSOLUTE_TTL_SECONDS,
} from '../src/modules/auth/session/index.js';

describe('P2-AUTH-05a: Refresh Token, CSRF, and Cookie Lifetimes Suite', () => {
  let keyring: SessionKeyring;

  beforeEach(async () => {
    const config = loadEnv({
      NODE_ENV: 'test',
      REFRESH_ACTIVE_KID: 'ref-k1',
      REFRESH_HMAC_KEY: 'test-refresh-integrity-secret-32-chars-ok!',
      REFRESH_DIGEST_KEY: 'test-refresh-digest-secret-32-chars-ok!!',
      CSRF_ACTIVE_KID: 'csrf-k1',
      CSRF_HMAC_KEY: 'test-csrf-hmac-secret-32-chars-minimum-ok!',
      MOCK_DATABASE: 'false',
    });
    keyring = new SessionKeyring(config);
    await keyring.initialize();
  });

  describe('Refresh Token Structure and Distinct Keys', () => {
    it('generates valid versioned refresh token with format r1.<kid>.<sid>.<gen>.<secret>.<MAC>', () => {
      const { rawToken, secret, digest } = createRefreshToken(keyring, {
        sessionId: 'sess_ref_100',
        generation: 1,
      });

      expect(typeof rawToken).toBe('string');
      expect(typeof secret).toBe('string');
      expect(typeof digest).toBe('string');

      const parts = rawToken.split('.');
      expect(parts.length).toBe(6);
      expect(parts[0]).toBe('r1');
      expect(parts[1]).toBe('ref-k1');
      expect(parts[2]).toBe('sess_ref_100');
      expect(parts[3]).toBe('1');
      expect(parts[4]).toBe(secret);
      expect(parts[5].length).toBeGreaterThan(0);

      const parsed = parseRefreshToken(rawToken);
      expect(parsed).not.toBeNull();
      expect(parsed?.sid).toBe('sess_ref_100');
      expect(parsed?.generation).toBe(1);

      // Verifies authentic MAC
      expect(verifyRefreshTokenMac(keyring, parsed!)).toBe(true);
    });

    it('enforces distinct integrity key and storage digest key', () => {
      const integrityKey = keyring.getRefreshHmacKey('ref-k1')!;
      const digestKey = keyring.getRefreshDigestKey('ref-k1')!;

      // Keys must be completely distinct
      expect(integrityKey.equals(digestKey)).toBe(false);

      const { rawToken, digest } = createRefreshToken(keyring, {
        sessionId: 'sess_ref_101',
        generation: 1,
      });

      // Digest is computed using digestKey, not stored as raw token
      const recomputedDigest = computeRefreshDigest(digestKey, rawToken);
      expect(digest).toBe(recomputedDigest);
      expect(rawToken).not.toBe(digest);
    });

    it('rejects forged MAC and malformed tokens', () => {
      const { rawToken } = createRefreshToken(keyring, {
        sessionId: 'sess_ref_102',
        generation: 1,
      });

      const parsed = parseRefreshToken(rawToken)!;
      // Tamper with MAC
      parsed.mac = crypto.randomBytes(32).toString('base64url');
      expect(verifyRefreshTokenMac(keyring, parsed)).toBe(false);

      // Malformed inputs
      expect(parseRefreshToken('not.enough.parts')).toBeNull();
      expect(parseRefreshToken('r2.k1.s1.1.sec.mac')).toBeNull(); // wrong version
      expect(parseRefreshToken('r1.k1.s1.0.sec.mac')).toBeNull(); // invalid gen <= 0
      expect(parseRefreshToken('r1.k1.s1.-1.sec.mac')).toBeNull();
      expect(parseRefreshToken('r1.k1.s1.abc.sec.mac')).toBeNull();
    });

    it('supports refresh key rotation with retiring key retention', () => {
      // Register an older retired refresh keypair
      keyring.registerRetiredRefreshKeys(
        'ref-k0-retired',
        'retired-refresh-integrity-key-32-chars!',
        'retired-refresh-digest-key-32-chars-ok!'
      );

      // Create token with the retired kid
      const { rawToken } = createRefreshToken(keyring, {
        sessionId: 'sess_retired_ref',
        generation: 3,
        kid: 'ref-k0-retired',
      });

      const parsed = parseRefreshToken(rawToken)!;
      expect(parsed.kid).toBe('ref-k0-retired');
      // Verifies successfully using the registered retired key
      expect(verifyRefreshTokenMac(keyring, parsed)).toBe(true);
    });
  });

  describe('CSRF Token Structure and Validation', () => {
    it('generates valid CSRF token with format c1.<kid>.<sid>.<nonce>.<mac>', () => {
      const csrfToken = createCsrfToken(keyring, {
        sessionId: 'sess_csrf_200',
      });

      expect(typeof csrfToken).toBe('string');
      const parts = csrfToken.split('.');
      expect(parts.length).toBe(5);
      expect(parts[0]).toBe('c1');
      expect(parts[1]).toBe('csrf-k1');
      expect(parts[2]).toBe('sess_csrf_200');

      const parsed = parseCsrfToken(csrfToken);
      expect(parsed).not.toBeNull();
      expect(parsed?.sid).toBe('sess_csrf_200');
      expect(verifyCsrfTokenMac(keyring, parsed!)).toBe(true);
    });

    it('validates CSRF request requiring matching header and cookie, valid MAC, and session binding', () => {
      const sessionId = 'sess_csrf_201';
      const token = createCsrfToken(keyring, { sessionId });

      // Successful validation: header === cookie and bound to same session
      expect(verifyCsrfRequest(keyring, token, token, sessionId)).toBe(true);

      // Cross-session mismatch
      expect(verifyCsrfRequest(keyring, token, token, 'different_session_id')).toBe(false);

      // Header and cookie value mismatch
      const otherToken = createCsrfToken(keyring, { sessionId });
      expect(verifyCsrfRequest(keyring, token, otherToken, sessionId)).toBe(false);

      // Missing header or cookie
      expect(verifyCsrfRequest(keyring, undefined, token, sessionId)).toBe(false);
      expect(verifyCsrfRequest(keyring, token, undefined, sessionId)).toBe(false);

      // Forged MAC
      const parsed = parseCsrfToken(token)!;
      const forgedToken = `c1.${parsed.kid}.${parsed.sid}.${parsed.nonce}.${crypto.randomBytes(32).toString('base64url')}`;
      expect(verifyCsrfRequest(keyring, forgedToken, forgedToken, sessionId)).toBe(false);
    });
  });

  describe('Role-specific Session Lifetimes and Cookie Attributes', () => {
    it('applies Candidate 7-day idle and 30-day absolute lifetimes', () => {
      const now = new Date('2026-11-23T00:00:00.000Z');
      const candidateLifetimes = computeSessionLifetimes('CANDIDATE', now);

      expect(candidateLifetimes.idleTtlMs).toBe(CANDIDATE_IDLE_TTL_SECONDS * 1000);
      expect(candidateLifetimes.absoluteTtlMs).toBe(CANDIDATE_ABSOLUTE_TTL_SECONDS * 1000);

      expect(candidateLifetimes.idleExpiresAt.toISOString()).toBe('2026-11-30T00:00:00.000Z');
      expect(candidateLifetimes.absoluteExpiresAt.toISOString()).toBe('2026-12-23T00:00:00.000Z');

      const remainingSeconds = computeRemainingCookieTtlSeconds(
        candidateLifetimes.idleExpiresAt,
        candidateLifetimes.absoluteExpiresAt,
        now
      );
      expect(remainingSeconds).toBe(CANDIDATE_IDLE_TTL_SECONDS);
    });

    it('applies Admin 12-hour idle and 24-hour absolute lifetimes', () => {
      const now = new Date('2026-11-23T00:00:00.000Z');
      const adminLifetimes = computeSessionLifetimes('ADMIN', now);

      expect(adminLifetimes.idleTtlMs).toBe(ADMIN_IDLE_TTL_SECONDS * 1000);
      expect(adminLifetimes.absoluteTtlMs).toBe(ADMIN_ABSOLUTE_TTL_SECONDS * 1000);

      expect(adminLifetimes.idleExpiresAt.toISOString()).toBe('2026-11-23T12:00:00.000Z');
      expect(adminLifetimes.absoluteExpiresAt.toISOString()).toBe('2026-11-24T00:00:00.000Z');

      const remainingSeconds = computeRemainingCookieTtlSeconds(
        adminLifetimes.idleExpiresAt,
        adminLifetimes.absoluteExpiresAt,
        now
      );
      expect(remainingSeconds).toBe(ADMIN_IDLE_TTL_SECONDS);
    });

    it('caps remaining cookie TTL by absolute session expiry', () => {
      const now = new Date('2026-11-23T00:00:00.000Z');
      // Absolute expiry in 2 hours, idle expiry in 7 days
      const idleExpiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      const absoluteExpiresAt = new Date(now.getTime() + 2 * 3600 * 1000);

      const remainingSeconds = computeRemainingCookieTtlSeconds(
        idleExpiresAt,
        absoluteExpiresAt,
        now
      );
      expect(remainingSeconds).toBe(2 * 3600); // Capped at absolute expiry
    });

    it('formats production __Host- cookies with Secure, SameSite=Lax, Path=/ and no Domain', () => {
      const refreshCookie = serializeRefreshCookie('ref_token_val', 3600, {
        isProduction: true,
        isSecure: true,
      });

      expect(refreshCookie).toContain('__Host-roundset_refresh=');
      expect(refreshCookie).toContain('Path=/');
      expect(refreshCookie).toContain('HttpOnly');
      expect(refreshCookie).toContain('SameSite=Lax');
      expect(refreshCookie).toContain('Secure');
      expect(refreshCookie).not.toContain('Domain=');

      const csrfCookie = serializeCsrfCookie('csrf_token_val', 3600, {
        isProduction: true,
        isSecure: true,
      });

      expect(csrfCookie).toContain('__Host-roundset_csrf=');
      expect(csrfCookie).toContain('Path=/');
      expect(csrfCookie).not.toContain('HttpOnly'); // JavaScript-readable!
      expect(csrfCookie).toContain('SameSite=Lax');
      expect(csrfCookie).toContain('Secure');
      expect(csrfCookie).not.toContain('Domain=');
    });

    it('parses cookies and clears both cookies on logout', () => {
      const rawHeader =
        '__Host-roundset_refresh=ref123; __Host-roundset_csrf=csrf456; other=val';
      const parsed = parseCookies(rawHeader);
      expect(extractRefreshCookie(parsed)).toBe('ref123');
      expect(extractCsrfCookie(parsed)).toBe('csrf456');

      const [clearRef, clearCsrf] = serializeClearCookies({
        isProduction: true,
        isSecure: true,
      });

      expect(clearRef).toContain('Max-Age=0');
      expect(clearRef).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      expect(clearRef).toContain('HttpOnly');

      expect(clearCsrf).toContain('Max-Age=0');
      expect(clearCsrf).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    });
  });
});
