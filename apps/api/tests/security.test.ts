import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { ApiErrorResponseSchema } from '@roundset/contracts';

describe('Security & Request IDs (P1-T03, P1-T07)', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    PORT: 8787,
    WEB_ORIGIN: 'http://localhost:5173',
    TRUST_PROXY_HOPS: 0,
  });

  const app = createApp({ env });

  it('P1-T03: Both successful and failed requests have matching valid request IDs in header and body', async () => {
    // 1. Successful request
    const successRes = await request(app).get('/api/v1/health/live');
    expect(successRes.status).toBe(200);
    const successHeaderId = successRes.headers['x-request-id'];
    expect(successHeaderId).toBeDefined();
    expect(successHeaderId.length).toBeGreaterThan(10);
    expect(successRes.body.meta.requestId).toBe(successHeaderId);

    // 2. Failed request (404)
    const failedRes = await request(app).get('/api/v1/unknown-endpoint');
    expect(failedRes.status).toBe(404);
    const failedHeaderId = failedRes.headers['x-request-id'];
    expect(failedHeaderId).toBeDefined();
    expect(failedHeaderId.length).toBeGreaterThan(10);
    expect(failedRes.body.error.requestId).toBe(failedHeaderId);
  });

  it('P1-T03: Server does not trust unsanitized client-provided request IDs', async () => {
    const maliciousClientRequestId = 'untrusted-spoofed-id-<script>alert(1)</script>';

    const res = await request(app)
      .get('/api/v1/health/live')
      .set('X-Request-ID', maliciousClientRequestId);

    expect(res.status).toBe(200);
    const assignedId = res.headers['x-request-id'];
    expect(assignedId).not.toBe(maliciousClientRequestId);
    expect(res.body.meta.requestId).not.toBe(maliciousClientRequestId);
    expect(res.body.meta.requestId).toBe(assignedId);
  });

  it('P1-T07: Unauthorized Origin header is rejected with 403 FORBIDDEN', async () => {
    const res = await request(app)
      .get('/api/v1/health/live')
      .set('Origin', 'http://malicious-attacker.com');

    expect(res.status).toBe(403);
    const parseResult = ApiErrorResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.error.code).toBe('FORBIDDEN');
      expect(parseResult.data.error.message).toBe('Forbidden origin');
      expect(parseResult.data.error.requestId).toBe(res.headers['x-request-id']);
    }
  });

  it('P1-T07: Configured WEB_ORIGIN is allowed and returns CORS headers', async () => {
    const res = await request(app)
      .get('/api/v1/health/live')
      .set('Origin', 'http://localhost:5173');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('P1-T07: Requests without an Origin header are permitted for CLI/health monitors', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('Security headers are injected via Helmet', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
