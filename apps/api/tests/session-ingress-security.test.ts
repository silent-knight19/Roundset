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
          JWT_PRIVATE_KEY_PEM: 'pem1',
          JWT_PUBLIC_KEY_PEM: 'pem2',
          REFRESH_HMAC_KEY: 'secret1-min-32-chars-long-ok!!',
          REFRESH_DIGEST_KEY: 'secret2-min-32-chars-long-ok!!',
          CSRF_HMAC_KEY: 'secret3-min-32-chars-long-ok!!',
        });
      }).toThrow('EDGE_AUTH_SECRET_CURRENT is required in PAGES_PROXY production mode');
    });

    it('requires complete cryptographic key configuration in production', () => {
      expect(() => {
        loadEnv({
          NODE_ENV: 'production',
          MONGODB_URI: 'mongodb://localhost:27017/prod',
          INGRESS_MODE: 'SINGLE_ORIGIN',
          // Missing JWT and HMAC keys
        });
      }).toThrow('JWT_PRIVATE_KEY_PEM is required in production environment');
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
