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

  it('rejects invalid mock-email settings and keys', () => {
    expect(() => loadEnv({ AUTH_DEV_MOCK_EMAIL: 'maybe' })).toThrow();
    expect(() => loadEnv({ AUTH_CHALLENGE_HMAC_KEY: 'short' })).toThrow();
    expect(() => loadEnv({ NODE_ENV: 'production', AUTH_DEV_MOCK_EMAIL: 'true' })).toThrow(/AUTH_DEV_MOCK_EMAIL/);
    expect(env.AUTH_DEV_MOCK_EMAIL).toBe(false);
  });
});
