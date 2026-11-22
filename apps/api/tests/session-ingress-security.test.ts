import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { loadEnv, EnvSchema } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { MockReadinessProvider } from '../src/core/readiness.js';

describe('P2-AUTH-05a: Ingress & Proxy Security Suite', () => {
  const readinessProvider = new MockReadinessProvider(true);

  describe('Configuration & Boot Ingress Guardrails', () => {
    it('rejects INGRESS_MODE=LOCAL in production environment', () => {
      expect(() => {
        loadEnv({
          NODE_ENV: 'production',
          MONGODB_URI: 'mongodb://localhost:27017/prod',
          INGRESS_MODE: 'LOCAL',
          POLICY_ID: 'roundset-prod-policy',
          POLICY_CONSENT_VERSION: 'v2026.11.23',
          JWT_PRIVATE_KEY_PEM: 'pem1',
          JWT_PUBLIC_KEY_PEM: 'pem2',
          REFRESH_HMAC_KEY: 'secret1-min-32-chars-long-ok!!',
          REFRESH_DIGEST_KEY: 'secret2-min-32-chars-long-ok!!',
          CSRF_HMAC_KEY: 'secret3-min-32-chars-long-ok!!',
        });
      }).toThrow('INGRESS_MODE=LOCAL is forbidden in production environment');
    });

    it('requires EDGE_AUTH_SECRET_CURRENT in PAGES_PROXY production mode', () => {
      expect(() => {
        loadEnv({
          NODE_ENV: 'production',
          MONGODB_URI: 'mongodb://localhost:27017/prod',
          INGRESS_MODE: 'PAGES_PROXY',
          POLICY_ID: 'roundset-prod-policy',
          POLICY_CONSENT_VERSION: 'v2026.11.23',
          JWT_PRIVATE_KEY_PEM: 'pem1',
          JWT_PUBLIC_KEY_PEM: 'pem2',
          REFRESH_HMAC_KEY: 'secret1-min-32-chars-long-ok!!',
          REFRESH_DIGEST_KEY: 'secret2-min-32-chars-long-ok!!',
          CSRF_HMAC_KEY: 'secret3-min-32-chars-long-ok!!',
        });
      }).toThrow('EDGE_AUTH_SECRET_CURRENT is required in PAGES_PROXY production mode');
    });

    it('R5: requires explicit approved POLICY_ID in production environment (placeholders rejected)', () => {
      expect(() => {
        loadEnv({
          NODE_ENV: 'production',
          MONGODB_URI: 'mongodb://localhost:27017/prod',
          INGRESS_MODE: 'SINGLE_ORIGIN',
          POLICY_ID: 'roundset-terms-privacy', // Default placeholder
          POLICY_CONSENT_VERSION: 'v2026.11.23',
          JWT_PRIVATE_KEY_PEM: 'pem1',
          JWT_PUBLIC_KEY_PEM: 'pem2',
          REFRESH_HMAC_KEY: 'secret1-min-32-chars-long-ok!!',
          REFRESH_DIGEST_KEY: 'secret2-min-32-chars-long-ok!!',
          CSRF_HMAC_KEY: 'secret3-min-32-chars-long-ok!!',
        });
      }).toThrow('Explicit approved POLICY_ID is required in production environment');
    });

    it('R5: requires explicit approved POLICY_CONSENT_VERSION in production environment (placeholders rejected)', () => {
      expect(() => {
        loadEnv({
          NODE_ENV: 'production',
          MONGODB_URI: 'mongodb://localhost:27017/prod',
          INGRESS_MODE: 'SINGLE_ORIGIN',
          POLICY_ID: 'roundset-prod-policy-approved',
          POLICY_CONSENT_VERSION: '2026-11-22', // Default placeholder
          JWT_PRIVATE_KEY_PEM: 'pem1',
          JWT_PUBLIC_KEY_PEM: 'pem2',
          REFRESH_HMAC_KEY: 'secret1-min-32-chars-long-ok!!',
          REFRESH_DIGEST_KEY: 'secret2-min-32-chars-long-ok!!',
          CSRF_HMAC_KEY: 'secret3-min-32-chars-long-ok!!',
        });
      }).toThrow('Explicit approved POLICY_CONSENT_VERSION is required in production environment');
    });

    it('requires complete cryptographic key configuration in production', () => {
      expect(() => {
        loadEnv({
          NODE_ENV: 'production',
          MONGODB_URI: 'mongodb://localhost:27017/prod',
          INGRESS_MODE: 'SINGLE_ORIGIN',
          POLICY_ID: 'roundset-prod-policy-approved',
          POLICY_CONSENT_VERSION: 'v2026.11.23',
          // Missing JWT and HMAC keys
        });
      }).toThrow('JWT_PRIVATE_KEY_PEM is required in production environment');
    });
  });

  describe('R4: Cryptographic Keyring Boot Validation and Restart Simulation', () => {
    it('fails boot initialization if active JWT private key and public key do not match', async () => {
      const { SessionKeyring } = await import('../src/modules/auth/session/keyring.js');
      const crypto = await import('node:crypto');

      const pair1 = crypto.generateKeyPairSync('ed25519');
      const pair2 = crypto.generateKeyPairSync('ed25519');

      const priv1 = pair1.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const pub2 = pair2.publicKey.export({ type: 'spki', format: 'pem' }).toString();

      const config = loadEnv({
        NODE_ENV: 'test',
        JWT_PRIVATE_KEY_PEM: priv1,
        JWT_PUBLIC_KEY_PEM: pub2, // Mismatched public key!
      });

      const keyring = new SessionKeyring(config);
      await expect(keyring.initialize()).rejects.toThrow(
        'Active JWT private key and public key do not form a valid cryptographic pair'
      );
    });

    it('fails boot initialization if refresh HMAC integrity and digest keys are identical', async () => {
      const { SessionKeyring } = await import('../src/modules/auth/session/keyring.js');

      const sameKey = 'identical-secret-key-32-chars-long-forbidden!';
      const config = loadEnv({
        NODE_ENV: 'test',
        REFRESH_HMAC_KEY: sameKey,
        REFRESH_DIGEST_KEY: sameKey,
      });

      const keyring = new SessionKeyring(config);
      await expect(keyring.initialize()).rejects.toThrow(
        'Refresh HMAC integrity key and digest key must be distinct'
      );
    });

    it('restart simulation: restores retired keys across restart and verifies old valid credentials', async () => {
      const {
        SessionKeyring,
        createRefreshToken,
        createCsrfToken,
        verifyRefreshTokenMac,
        parseRefreshToken,
        verifyCsrfTokenMac,
        parseCsrfToken,
        verifyAccessToken,
        signAccessToken,
      } = await import('../src/modules/auth/session/index.js');
      const crypto = await import('node:crypto');

      // 1. Pre-restart configuration: generate initial active keys (generation 0)
      const oldJwtPair = crypto.generateKeyPairSync('ed25519');
      const oldPriv = oldJwtPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const oldPub = oldJwtPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const oldRefreshHmac = 'pre-restart-refresh-integrity-key-32chars!';
      const oldRefreshDigest = 'pre-restart-refresh-digest-key-32-chars-ok!';
      const oldCsrfHmac = 'pre-restart-csrf-hmac-key-32-chars-minimum!';

      const preRestartConfig = loadEnv({
        NODE_ENV: 'test',
        JWT_ACTIVE_KID: 'jwt-k0',
        JWT_PRIVATE_KEY_PEM: oldPriv,
        JWT_PUBLIC_KEY_PEM: oldPub,
        REFRESH_ACTIVE_KID: 'ref-k0',
        REFRESH_HMAC_KEY: oldRefreshHmac,
        REFRESH_DIGEST_KEY: oldRefreshDigest,
        CSRF_ACTIVE_KID: 'csrf-k0',
        CSRF_HMAC_KEY: oldCsrfHmac,
      });

      const preKeyring = new SessionKeyring(preRestartConfig);
      await preKeyring.initialize();

      // Issue active session credentials before restart
      const preAccessToken = await signAccessToken(preKeyring, {
        userId: '507f1f77bcf86cd799439011',
        sessionId: 'sess_pre_restart',
        epoch: 1,
      });
      const { rawToken: preRefresh } = createRefreshToken(preKeyring, {
        sessionId: 'sess_pre_restart',
        generation: 1,
      });
      const preCsrf = createCsrfToken(preKeyring, {
        sessionId: 'sess_pre_restart',
      });

      // 2. Post-restart simulation: new active keys installed, old keys retained in retired configuration
      const newJwtPair = crypto.generateKeyPairSync('ed25519');
      const newPriv = newJwtPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const newPub = newJwtPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

      const postRestartConfig = loadEnv({
        NODE_ENV: 'test',
        JWT_ACTIVE_KID: 'jwt-k1',
        JWT_PRIVATE_KEY_PEM: newPriv,
        JWT_PUBLIC_KEY_PEM: newPub,
        JWT_RETIRED_KEYS_JSON: JSON.stringify([
          { kid: 'jwt-k0', publicKeyPem: oldPub },
        ]),
        REFRESH_ACTIVE_KID: 'ref-k1',
        REFRESH_HMAC_KEY: 'new-active-refresh-integrity-32chars-ok!!',
        REFRESH_DIGEST_KEY: 'new-active-refresh-digest-32-chars-ok!!',
        REFRESH_RETIRED_KEYS_JSON: JSON.stringify([
          { kid: 'ref-k0', hmacSecret: oldRefreshHmac, digestSecret: oldRefreshDigest },
        ]),
        CSRF_ACTIVE_KID: 'csrf-k1',
        CSRF_HMAC_KEY: 'new-active-csrf-hmac-secret-32chars-ok!',
        CSRF_RETIRED_KEYS_JSON: JSON.stringify([
          { kid: 'csrf-k0', hmacSecret: oldCsrfHmac },
        ]),
      });

      const postKeyring = new SessionKeyring(postRestartConfig);
      await postKeyring.initialize();

      // Old pre-restart credentials must remain fully verifiable!
      const jwtPayload = await verifyAccessToken(postKeyring, preAccessToken);
      expect(jwtPayload.sid).toBe('sess_pre_restart');

      const parsedRefresh = parseRefreshToken(preRefresh)!;
      expect(parsedRefresh.kid).toBe('ref-k0');
      expect(verifyRefreshTokenMac(postKeyring, parsedRefresh)).toBe(true);

      const parsedCsrf = parseCsrfToken(preCsrf)!;
      expect(parsedCsrf.kid).toBe('csrf-k0');
      expect(verifyCsrfTokenMac(postKeyring, parsedCsrf)).toBe(true);
    });
  });

  describe('PAGES_PROXY Ingress Enforcement', () => {
    const edgeSecret = 'super-secret-edge-authentication-key-min-32!';
    const proxyConfig = EnvSchema.parse({
      NODE_ENV: 'test',
      INGRESS_MODE: 'PAGES_PROXY',
      EDGE_AUTH_SECRET_CURRENT: edgeSecret,
      MOCK_DATABASE: false,
      WEB_ORIGIN: 'http://localhost:5173',
    });

    const app = createApp({
      env: proxyConfig,
      readinessProvider,
    });

    it('rejects direct Render access lacking X-Roundset-Edge-Auth header with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/auth/meta')
        .set('Origin', 'http://localhost:5173');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe('Edge authentication required');
    });

    it('rejects invalid or spoofed edge secrets with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/auth/meta')
        .set('Origin', 'http://localhost:5173')
        .set('X-Roundset-Edge-Auth', 'wrong-secret-token-attempting-access!');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe('Invalid edge authentication');
    });

    it('allows access when valid X-Roundset-Edge-Auth header is provided', async () => {
      const res = await request(app)
        .get('/api/v1/auth/meta')
        .set('Origin', 'http://localhost:5173')
        .set('X-Roundset-Edge-Auth', edgeSecret);

      expect(res.status).toBe(200);
      expect(res.body.data.activePolicyId).toBeDefined();
    });

    it('supports previous edge secret during credential rollover', async () => {
      const prevSecret = 'previous-edge-authentication-key-min-32!!';
      const rolloverConfig = EnvSchema.parse({
        NODE_ENV: 'test',
        INGRESS_MODE: 'PAGES_PROXY',
        EDGE_AUTH_SECRET_CURRENT: edgeSecret,
        EDGE_AUTH_SECRET_PREVIOUS: prevSecret,
        MOCK_DATABASE: false,
        WEB_ORIGIN: 'http://localhost:5173',
      });

      const rolloverApp = createApp({
        env: rolloverConfig,
        readinessProvider,
      });

      const res = await request(rolloverApp)
        .get('/api/v1/auth/meta')
        .set('Origin', 'http://localhost:5173')
        .set('X-Roundset-Edge-Auth', prevSecret);

      expect(res.status).toBe(200);
    });

    it('health probes /health/live and /health/ready remain accessible without edge auth or Origin', async () => {
      const liveRes = await request(app).get('/api/v1/health/live');
      expect(liveRes.status).toBe(200);
      expect(liveRes.body.data.status).toBe('ok');

      const readyRes = await request(app).get('/api/v1/health/ready');
      expect(readyRes.status).toBe(200);
      expect(readyRes.body.data.ready).toBe(true);
    });
  });

  describe('Origin and Fetch Metadata Enforcement on Sensitive Routes', () => {
    const config = loadEnv({
      NODE_ENV: 'test',
      INGRESS_MODE: 'LOCAL',
      WEB_ORIGIN: 'http://localhost:5173',
      MOCK_DATABASE: 'false',
    });

    const app = createApp({
      env: config,
      readinessProvider,
    });

    it('rejects POST /api/v1/auth/refresh without Origin header', async () => {
      const res = await request(app).post('/api/v1/auth/refresh');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects POST /api/v1/auth/refresh with mismatched Origin', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', 'http://malicious-site.test');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects cross-site Sec-Fetch-Site requests', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', 'http://localhost:5173')
        .set('Sec-Fetch-Site', 'cross-site');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toContain('Cross-site');
    });
  });
});
