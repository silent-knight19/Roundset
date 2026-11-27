import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionResponseSchema } from '@roundset/contracts';
import { loadEnv } from '../src/config/env.js';
import { PasswordLoginService } from '../src/modules/auth/password/login.service.js';
import type { PasswordService } from '../src/modules/auth/password/password.service.js';
import { PasswordHashPolicyError } from '../src/modules/auth/password/types.js';
import { AuthRateLimitService } from '../src/modules/auth/rate-limit/rate-limit.service.js';
import { RateLimitExceededError } from '../src/modules/auth/rate-limit/types.js';
import { SessionKeyring } from '../src/modules/auth/session/keyring.js';
import { verifyAccessToken } from '../src/modules/auth/session/jwt.js';
import type { IAuthRateLimit } from '../src/modules/identity/models/auth-rate-limit.model.js';

const stores = vi.hoisted(() => ({
  findUser: vi.fn(), userExec: vi.fn(),
  findIdentity: vi.fn(), identityExec: vi.fn(),
  fence: vi.fn(), fenceExec: vi.fn(),
  updateIdentity: vi.fn(), updateExec: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../src/modules/identity/models/index.js', () => ({
  getUserModel: () => ({ findOne: stores.findUser, findOneAndUpdate: stores.fence }),
  getAuthIdentityModel: () => ({ findOne: stores.findIdentity, updateOne: stores.updateIdentity }),
  getSessionModel: () => ({ create: stores.createSession }),
}));

const input = { email: 'candidate@example.test', password: 'Synthetic-test-password-123!' };
const requestId = '00000000-0000-4000-8000-000000000004';

function fixture() {
  const user = {
    _id: new Types.ObjectId(),
    emailNormalized: input.email,
    displayName: 'Candidate',
    role: 'CANDIDATE',
    accountStatus: 'ACTIVE',
    emailVerifiedAt: new Date(),
    updatedAt: new Date(),
    identityVersion: 4,
    sessionEpoch: 2,
  };
  const identity = { _id: new Types.ObjectId(), passwordHash: 'synthetic-test-hash' };
  stores.userExec.mockResolvedValue(user);
  stores.identityExec.mockResolvedValue(identity);
  stores.fenceExec.mockResolvedValue(user);
  let active = false;
  const driver = {
    startTransaction: vi.fn(() => { active = true; }),
    inTransaction: vi.fn(() => active),
    commitTransaction: vi.fn(async () => { active = false; }),
    abortTransaction: vi.fn(async () => { active = false; }),
    endSession: vi.fn(async () => undefined),
  };
  const session = driver as unknown as ClientSession;
  const connection = {
    readyState: 1,
    startSession: vi.fn(async () => session),
  } as unknown as Connection;
  const reservation = { count: 1, remaining: 4, windowEnd: new Date(Date.now() + 900_000) };
  const passwords = {
    verifyPassword: vi.fn(async () => true),
    verifyDummy: vi.fn(async () => undefined),
  };
  const rateLimits = {
    consumeOrThrow: vi.fn(async () => reservation),
    reserveLoginAttempt: vi.fn(async () => reservation),
    releaseProvenLoginAttempt: vi.fn(async () => true),
  };
  const config = loadEnv({ NODE_ENV: 'test' });
  const keyring = new SessionKeyring(config);
  const service = new PasswordLoginService({
    connection, config, keyring,
    passwords: passwords as unknown as PasswordService,
    rateLimits: rateLimits as unknown as AuthRateLimitService,
  });
  return { user, identity, driver, session, connection, reservation, passwords, rateLimits, keyring, service };
}

describe('P2-AUTH-03b password login', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stores.findUser.mockReturnValue({ exec: stores.userExec });
    stores.findIdentity.mockReturnValue({ exec: stores.identityExec });
    stores.fence.mockReturnValue({ exec: stores.fenceExec });
    stores.updateIdentity.mockReturnValue({ exec: stores.updateExec });
    stores.updateExec.mockResolvedValue({ matchedCount: 1 });
    stores.createSession.mockResolvedValue([]);
  });

  it('reserves the guess budget before lookup and rejects a capped attempt without hashing', async () => {
    const f = fixture();
    f.rateLimits.reserveLoginAttempt.mockRejectedValueOnce(new RateLimitExceededError(60, 'AUTH_RATE_LIMITED'));
    await expect(f.service.login(input, '127.0.0.1', requestId, false)).rejects.toMatchObject({ statusCode: 429 });
    expect(f.rateLimits.consumeOrThrow).toHaveBeenCalledWith('LOGIN_IP', '127.0.0.1');
    expect(f.rateLimits.reserveLoginAttempt).toHaveBeenCalledWith(input.email);
    expect(stores.findUser).not.toHaveBeenCalled();
    expect(f.passwords.verifyPassword).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'passwordless'])('uses the dummy path for a %s account without refunding its guess', async (kind) => {
    const f = fixture();
    if (kind === 'unknown') stores.userExec.mockResolvedValue(null);
    else stores.identityExec.mockResolvedValue(null);
    await expect(f.service.login(input, '127.0.0.1', requestId, false)).rejects.toMatchObject({
      statusCode: 401, code: 'INVALID_CREDENTIALS',
    });
    expect(f.passwords.verifyDummy).toHaveBeenCalledWith(input.password);
    expect(f.passwords.verifyPassword).not.toHaveBeenCalled();
    expect(f.rateLimits.releaseProvenLoginAttempt).not.toHaveBeenCalled();
    expect(stores.createSession).not.toHaveBeenCalled();
  });

  it('does not disclose suspension to an unproven password', async () => {
    const f = fixture();
    f.user.accountStatus = 'SUSPENDED';
    f.passwords.verifyPassword.mockResolvedValueOnce(false);
    await expect(f.service.login(input, '127.0.0.1', requestId, false)).rejects.toMatchObject({
      statusCode: 401, code: 'INVALID_CREDENTIALS',
    });
    expect(f.rateLimits.releaseProvenLoginAttempt).not.toHaveBeenCalled();
    expect(stores.createSession).not.toHaveBeenCalled();
    await expect(f.service.login(input, '127.0.0.1', requestId, false)).rejects.toMatchObject({
      statusCode: 403, code: 'ACCOUNT_SUSPENDED',
    });
    expect(f.rateLimits.releaseProvenLoginAttempt).toHaveBeenCalledWith(f.reservation);
    expect(stores.createSession).not.toHaveBeenCalled();
  });

  it('does not disclose malformed stored password material', async () => {
    const f = fixture();
    f.passwords.verifyPassword.mockRejectedValueOnce(new PasswordHashPolicyError('synthetic invalid hash'));
    await expect(f.service.login(input, '127.0.0.1', requestId, false)).rejects.toMatchObject({
      statusCode: 401, code: 'INVALID_CREDENTIALS',
    });
    expect(f.passwords.verifyDummy).toHaveBeenCalledWith(input.password);
    expect(f.rateLimits.releaseProvenLoginAttempt).not.toHaveBeenCalled();
  });

  it.each([['CANDIDATE', 7 * 86400, 30 * 86400], ['ADMIN', 12 * 3600, 24 * 3600]] as const)(
    'issues a committed %s session with correct lifetimes and cookie controls',
    async (role, idleSeconds, absoluteSeconds) => {
      const f = fixture();
      f.user.role = role;
      const result = await f.service.login(input, '127.0.0.1', requestId, true);
      const response = SessionResponseSchema.parse(result.sessionResponse);
      expect(response.data.user.role).toBe(role);
      const payload = await verifyAccessToken(f.keyring, response.data.accessToken);
      expect(payload).toMatchObject({ sub: String(f.user._id), sid: response.data.session.id, epoch: 2 });
      const persisted = stores.createSession.mock.calls[0]?.[0]?.[0];
      expect(persisted).toMatchObject({
        sessionId: payload.sid, userId: f.user._id, status: 'ACTIVE',
        epochAtIssue: 2, generation: 1, currentRefreshDigest: expect.any(String),
      });
      expect(persisted.idleExpiresAt.getTime() - persisted.createdAt.getTime()).toBe(idleSeconds * 1000);
      expect(persisted.absoluteExpiresAt.getTime() - persisted.createdAt.getTime()).toBe(absoluteSeconds * 1000);
      expect(stores.createSession).toHaveBeenCalledWith([persisted], { session: f.session });
      expect(stores.fence).toHaveBeenCalledWith(expect.objectContaining({
        _id: f.user._id, accountStatus: 'ACTIVE', sessionEpoch: 2, identityVersion: 4,
      }), { $set: { updatedAt: expect.any(Date) } }, { session: f.session, new: true, timestamps: false });
      expect(stores.updateIdentity).toHaveBeenCalledWith(expect.objectContaining({
        _id: f.identity._id, userId: f.user._id, provider: 'PASSWORD', subject: input.email,
        passwordHash: f.identity.passwordHash,
      }), { $set: { lastUsedAt: expect.any(Date) } }, { session: f.session });
      expect(result.setCookieHeaders[0]).toContain('__Host-roundset_refresh=');
      expect(result.setCookieHeaders[0]).toContain('HttpOnly');
      expect(result.setCookieHeaders[1]).toContain('__Host-roundset_csrf=');
      expect(result.setCookieHeaders[1]).not.toContain('HttpOnly');
      expect(result.setCookieHeaders.every(cookie => cookie.includes('Secure') && cookie.includes('SameSite=Lax'))).toBe(true);
      expect(result.setCookieHeaders[0]).not.toContain(persisted.currentRefreshDigest);
      expect(f.driver.commitTransaction).toHaveBeenCalledTimes(1);
      expect(f.rateLimits.releaseProvenLoginAttempt).toHaveBeenCalledWith(f.reservation);
    }
  );

  it('rejects an account whose epoch or credential version changed after comparison', async () => {
    const f = fixture();
    stores.userExec.mockResolvedValueOnce(f.user).mockResolvedValueOnce(null);
    await expect(f.service.login(input, '127.0.0.1', requestId, false)).rejects.toMatchObject({
      statusCode: 401, code: 'INVALID_CREDENTIALS',
    });
    expect(stores.fence).not.toHaveBeenCalled();
    expect(stores.createSession).not.toHaveBeenCalled();
    expect(f.driver.abortTransaction).toHaveBeenCalledTimes(1);
  });

  it('aborts when the exact compared credential has changed', async () => {
    const f = fixture();
    stores.updateExec.mockResolvedValueOnce({ matchedCount: 0 });
    await expect(f.service.login(input, '127.0.0.1', requestId, false)).rejects.toMatchObject({
      statusCode: 401, code: 'INVALID_CREDENTIALS',
    });
    expect(stores.createSession).not.toHaveBeenCalled();
    expect(f.driver.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.driver.commitTransaction).not.toHaveBeenCalled();
  });

  it('does not return credentials or replay writes after an unresolved commit', async () => {
    const f = fixture();
    f.driver.commitTransaction.mockRejectedValue(Object.assign(new Error('synthetic uncertain commit'), {
      errorLabels: ['UnknownTransactionCommitResult'],
      hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult',
    }));
    await expect(f.service.login(input, '127.0.0.1', requestId, false)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(stores.createSession).toHaveBeenCalledTimes(1);
    expect(f.driver.abortTransaction).not.toHaveBeenCalled();
  });
});

describe('P2-AUTH-03b persistent login reservation refunds', () => {
  function fixtureRate() {
    const execute = vi.fn().mockResolvedValue({ count: 0 });
    const update = vi.fn().mockReturnValue({ exec: execute });
    const service = new AuthRateLimitService({
      rateLimitModel: { findOneAndUpdate: update } as unknown as Model<IAuthRateLimit>,
      hmacSecret: 'synthetic-secret-for-rate-limit-tests',
    });
    const windowEnd = new Date(Date.now() + 900_000);
    const endMs = windowEnd.getTime();
    const consumed = vi.spyOn(service, 'consumeOrThrow').mockResolvedValue({ count: 1, remaining: 4, windowEnd });
    return { service, consumed, endMs, update, execute };
  }

  it('retries a failed increment when a concurrent refund opens capacity', async () => {
    const windowEnd = new Date(Date.now() + 900_000);
    const execute = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ count: 5, windowEnd });
    const findOneAndUpdate = vi.fn().mockReturnValue({ exec: execute });
    const findOne = vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({ count: 4, windowEnd }) });
    const service = new AuthRateLimitService({
      rateLimitModel: { findOneAndUpdate, findOne } as unknown as Model<IAuthRateLimit>,
      hmacSecret: 'synthetic-secret-for-rate-limit-tests',
    });
    await expect(service.reserveLoginAttempt(input.email)).resolves.toMatchObject({ count: 5, remaining: 0 });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('refunds only the reserved original window and only once', async () => {
    const f = fixtureRate();
    const reservation = await f.service.reserveLoginAttempt(input.email);
    expect(f.consumed).toHaveBeenCalledWith('LOGIN_FAIL_EMAIL', input.email);
    reservation.windowEnd.setTime(0);
    expect(await f.service.releaseProvenLoginAttempt({ ...reservation })).toBe(false);
    expect(await f.service.releaseProvenLoginAttempt(reservation)).toBe(true);
    expect(await f.service.releaseProvenLoginAttempt(reservation)).toBe(false);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledWith({
      bucketKey: f.service.computeBucketKey('LOGIN_FAIL_EMAIL', input.email),
      windowEnd: new Date(f.endMs), count: { $gt: 0 },
    }, { $inc: { count: -1 } }, { new: true });
  });

  it.each(['expired window', 'ambiguous failure'])('does not retry a refund after %s', async (kind) => {
    const f = fixtureRate();
    const reservation = await f.service.reserveLoginAttempt(input.email);
    if (kind === 'expired window') f.execute.mockResolvedValue(null);
    else f.execute.mockRejectedValue(new Error('synthetic ambiguous result'));
    expect(await f.service.releaseProvenLoginAttempt(reservation)).toBe(false);
    expect(await f.service.releaseProvenLoginAttempt(reservation)).toBe(false);
    expect(f.update).toHaveBeenCalledTimes(1);
  });
});
