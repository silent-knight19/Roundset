import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { OtpInvalidError } from '../src/modules/auth/otp/types.js';
import { RateLimitExceededError } from '../src/modules/auth/rate-limit/types.js';
import type { PasswordAuthRouteServices } from '../src/routes/password-auth.js';

const origin = 'http://localhost:5173';
const env = loadEnv({ NODE_ENV: 'test', WEB_ORIGIN: origin });
const registrationId = 'a'.repeat(32);
const nonce = 'b'.repeat(128);
const email = 'candidate@example.test';
const password = 'test-passphrase-123!';
const input = { email, password, consentVersion: env.POLICY_CONSENT_VERSION };
const cookie = 'roundset_reg=reg1.' + registrationId + '.' + nonce;

function fixture() {
  const services = {
    assertReady: vi.fn(async () => {}),
    registration: {
      register: vi.fn(async () => ({ registrationId, nonce })),
      resend: vi.fn(async () => {}),
      verify: vi.fn(async () => {}),
    },
    login: {
      login: vi.fn(async () => ({
        sessionResponse: {
          data: {
            accessToken: 'test-access-token', tokenType: 'Bearer' as const,
            expiresInSeconds: 900,
            user: { id: 'test-user', email, emailVerified: true, displayName: 'Candidate',
              role: 'CANDIDATE' as const, accountStatus: 'ACTIVE' as const },
            session: { id: 'test-session', expiresAt: new Date().toISOString() },
          },
          meta: { requestId: 'd7644dd3-ace1-4ca9-9bb2-1453f815160b' },
        },
        setCookieHeaders: ['roundset_refresh=test; HttpOnly', 'roundset_csrf=test'] as [string, string],
      })),
    },
    recovery: { forgot: vi.fn(async () => {}), reset: vi.fn(async () => {}) },
  } satisfies PasswordAuthRouteServices;
  const app = createApp({ env, passwordAuth: services });
  return { services, post: (path: string) => request(app).post('/api/v1/auth' + path).set('Origin', origin) };
}

describe('P2-AUTH-03b HTTP contract', () => {
  it('returns only public registration data and an HttpOnly receipt', async () => {
    const { post, services } = fixture();
    const res = await post('/register').send(input);
    expect(res.status).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body.data).sort()).toEqual(['message', 'registrationId']);
    expect(res.body.data.registrationId).toBe(registrationId);
    expect(res.headers['set-cookie'][0]).toContain(cookie);
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(res.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(services.registration.register).toHaveBeenCalledOnce();
  });

  it('rejects foreign origins, cross-site requests and undeclared fields before service calls', async () => {
    const { post, services } = fixture();
    expect((await post('/register').set('Origin', 'https://invalid.example').send(input)).status).toBe(403);
    expect((await post('/register').set('Sec-Fetch-Site', 'cross-site').send(input)).status).toBe(403);
    expect((await post('/register').send({ ...input, role: 'ADMIN' })).status).toBe(400);
    expect(services.registration.register).not.toHaveBeenCalled();
  });

  it('passes a nonce only if cookie and request IDs match', async () => {
    const { post, services } = fixture();
    services.registration.verify.mockRejectedValueOnce(new OtpInvalidError());
    const res = await post('/verify-email').set('Cookie', cookie).send({ registrationId: 'c'.repeat(32), code: '123456' });
    expect(res.status).toBe(400);
    expect(services.registration.verify).toHaveBeenCalledWith('c'.repeat(32), undefined, '123456', expect.any(String), expect.any(String));
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('verification clears only the registration cookie and issues no session', async () => {
    const { post, services } = fixture();
    const res = await post('/verify-email').set('Cookie', cookie).send({ registrationId, code: '123456' });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(res.headers['set-cookie']).toHaveLength(1);
    expect(res.headers['set-cookie'][0]).toContain('roundset_reg=;');
    expect(res.headers['set-cookie'][0]).toContain('Max-Age=0');
    expect(services.registration.verify).toHaveBeenCalledWith(registrationId, nonce, '123456', expect.any(String), expect.any(String));
  });

  it('returns generic resend data and the rate-limit retry header', async () => {
    const { post, services } = fixture();
    const res = await post('/otp/resend').set('Cookie', cookie).send({ registrationId });
    expect(res.status).toBe(202);
    expect(Object.keys(res.body.data)).toEqual(['message']);
    expect(services.registration.resend).toHaveBeenCalledWith(registrationId, nonce, expect.any(String));
    services.registration.resend.mockRejectedValueOnce(new RateLimitExceededError(60, 'OTP_RATE_LIMITED'));
    const limited = await post('/otp/resend').set('Cookie', cookie).send({ registrationId });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
  });

  it('login returns the bearer DTO plus two distinct cookies', async () => {
    const { post } = fixture();
    const res = await post('/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.data.tokenType).toBe('Bearer');
    expect(res.headers['set-cookie']).toHaveLength(2);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('forgot is generic and reset returns 204 without clearing unrelated cookies', async () => {
    const { post, services } = fixture();
    const forgot = await post('/password/forgot').send({ email });
    expect(forgot.status).toBe(202);
    expect(Object.keys(forgot.body.data)).toEqual(['message']);
    const reset = await post('/password/reset').send({ email, code: '123456', newPassword: password });
    expect(reset.status).toBe(204);
    expect(reset.headers['set-cookie']).toBeUndefined();
    expect(services.recovery.reset).toHaveBeenCalledOnce();
  });

  it('fails closed without configured services or when readiness fails', async () => {
    const disabled = createApp({ env });
    expect((await request(disabled).post('/api/v1/auth/login').set('Origin', origin).send({ email, password })).status).toBe(503);
    const { post, services } = fixture();
    services.assertReady.mockRejectedValueOnce(new (await import('../src/core/errors.js')).ServiceUnavailableError('not ready'));
    expect((await post('/login').send({ email, password })).status).toBe(503);
    expect(services.login.login).not.toHaveBeenCalled();
  });

  it('restricts mock authentication configuration to an isolated database and explicit keys', () => {
    const raw = { NODE_ENV: 'test', AUTH_DEV_MOCK_EMAIL: 'true',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/roundset_test?replicaSet=rs0',
      AUTH_CHALLENGE_HMAC_KEY: randomBytes(32).toString('hex'),
      REFRESH_HMAC_KEY: randomBytes(32).toString('hex'),
      REFRESH_DIGEST_KEY: randomBytes(32).toString('hex'),
      CSRF_HMAC_KEY: randomBytes(32).toString('hex'),
    };
    expect(loadEnv(raw).AUTH_DEV_MOCK_EMAIL).toBe(true);
    for (const overrides of [
      { MONGODB_URI: 'mongodb://127.0.0.1:27017/roundset?replicaSet=rs0' },
      { MONGODB_URI: 'mongodb://remote.example:27017/roundset_test?replicaSet=rs0' },
      { WEB_ORIGIN: 'http://remote.example' }, { TRUST_PROXY_HOPS: 1 },
      { REFRESH_HMAC_KEY: undefined }, { CSRF_HMAC_KEY: raw.REFRESH_HMAC_KEY },
      { MOCK_DATABASE: true }, { INGRESS_MODE: 'SINGLE_ORIGIN' },
    ]) expect(() => loadEnv({ ...raw, ...overrides })).toThrow(/AUTH_DEV_MOCK_EMAIL/);
  });

  it('shares pre-database flood protection across all six password auth endpoints', async () => {
    const { post, services } = fixture();
    // Invalid bodies avoid invoking the services; admission must still be counted.
    for (let i = 0; i < 60; i += 1) {
      expect((await post('/login').send({})).status).toBe(400);
    }
    for (const path of ['/register', '/otp/resend', '/verify-email', '/login', '/password/forgot', '/password/reset']) {
      const blocked = await post(path).send({});
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.headers['cache-control']).toBe('no-store');
    }
    expect(services.assertReady).not.toHaveBeenCalled();
    expect(services.registration.register).not.toHaveBeenCalled();
    expect(services.registration.resend).not.toHaveBeenCalled();
    expect(services.registration.verify).not.toHaveBeenCalled();
    expect(services.login.login).not.toHaveBeenCalled();
    expect(services.recovery.forgot).not.toHaveBeenCalled();
    expect(services.recovery.reset).not.toHaveBeenCalled();
  }, 15000);

  it('charges malformed and oversized JSON before parsing across all password routes', async () => {
    const { post, services } = fixture();
    const paths = ['/register', '/otp/resend', '/verify-email', '/login', '/password/forgot', '/password/reset'];
    const oversized = JSON.stringify({ extra: 'x'.repeat(64 * 1024) });
    for (let i = 0; i < 60; i += 1) {
      const body = i % 2 === 0 ? '{' : oversized;
      const response = await post(paths[i % paths.length]!).type('application/json').send(body);
      expect(response.status).toBe(i % 2 === 0 ? 400 : 413);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.error.code).toBe(i % 2 === 0 ? 'INVALID_INPUT' : 'PAYLOAD_TOO_LARGE');
    }
    for (const path of paths) {
      for (const body of ['{', oversized]) {
        const blocked = await post(path).type('application/json').send(body);
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        expect(blocked.headers['cache-control']).toBe('no-store');
        expect(blocked.body.error.code).toBe('AUTH_RATE_LIMITED');
      }
    }
    expect(services.assertReady).not.toHaveBeenCalled();
    expect(services.registration.register).not.toHaveBeenCalled();
    expect(services.registration.resend).not.toHaveBeenCalled();
    expect(services.registration.verify).not.toHaveBeenCalled();
    expect(services.login.login).not.toHaveBeenCalled();
    expect(services.recovery.forgot).not.toHaveBeenCalled();
    expect(services.recovery.reset).not.toHaveBeenCalled();
    // Non-password session endpoints still use the original body parser.
    expect((await post('/refresh').type('application/json').send('{')).status).toBe(400);
    expect((await post('/refresh').type('application/json').send(oversized)).status).toBe(413);
  }, 15000);

  it('rejects invalid mock-email settings and keys', () => {
    expect(() => loadEnv({ AUTH_DEV_MOCK_EMAIL: 'maybe' })).toThrow();
    expect(() => loadEnv({ AUTH_CHALLENGE_HMAC_KEY: 'short' })).toThrow();
    expect(() => loadEnv({ NODE_ENV: 'production', AUTH_DEV_MOCK_EMAIL: 'true' })).toThrow(/AUTH_DEV_MOCK_EMAIL/);
    expect(env.AUTH_DEV_MOCK_EMAIL).toBe(false);
  });
});
