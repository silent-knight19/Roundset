import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { MockReadinessProvider } from '../src/core/readiness.js';
import {
  SessionKeyring,
  SessionService,
  createRefreshToken,
  createCsrfToken,
  signAccessToken,
} from '../src/modules/auth/session/index.js';
import {
  SessionModel,
  UserModel,
  SecurityAuditEventModel,
  type SessionDocument,
  type UserDocument,
  type SecurityAuditEventDocument,
} from '../src/modules/identity/models/index.js';
import * as jose from 'jose';

describe('P2-AUTH-05a: Auth HTTP Endpoints Suite', () => {
  const allowedOrigin = 'http://localhost:5173';
  const env = loadEnv({
    NODE_ENV: 'test',
    WEB_ORIGIN: allowedOrigin,
    INGRESS_MODE: 'LOCAL',
    MOCK_DATABASE: 'false',
    POLICY_ID: 'roundset-terms-privacy-2026',
    POLICY_CONSENT_VERSION: '2026-11-22',
    REGISTRATION_MODE: 'PUBLIC',
    REFRESH_ACTIVE_KID: 'ref-k1',
    REFRESH_HMAC_KEY: 'test-refresh-integrity-secret-32-chars-ok!',
    REFRESH_DIGEST_KEY: 'test-refresh-digest-secret-32-chars-ok!!',
    CSRF_ACTIVE_KID: 'csrf-k1',
    CSRF_HMAC_KEY: 'test-csrf-hmac-secret-32-chars-minimum-ok!',
  });

  let keyring: SessionKeyring;
  let sessionService: SessionService;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    keyring = new SessionKeyring(env);
    await keyring.initialize();

    // Default mocked healthy connection and transaction session for deterministic unit tests
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true, writable: true });
    let defaultInTx = false;
    const defaultMockSession = {
      startTransaction: vi.fn(() => { defaultInTx = true; }),
      commitTransaction: vi.fn(async () => { defaultInTx = false; }),
      abortTransaction: vi.fn(async () => { defaultInTx = false; }),
      endSession: vi.fn(async () => {}),
      inTransaction: vi.fn(() => defaultInTx),
    };
    vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(defaultMockSession as unknown as mongoose.ClientSession);
    vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({ matchedCount: 0, modifiedCount: 0, acknowledged: true, upsertedCount: 0, upsertedId: null });

    sessionService = new SessionService(env, keyring, mongoose.connection);
    app = createApp({
      env,
      sessionService,
      readinessProvider: new MockReadinessProvider(true),
    });
  });

  describe('GET /api/v1/auth/meta', () => {
    it('returns server-configured active policy metadata with Cache-Control: no-store', async () => {
      const res = await request(app).get('/api/v1/auth/meta');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data).toEqual({
        activePolicyId: 'roundset-terms-privacy-2026',
        activeConsentVersion: '2026-11-22',
        registrationMode: 'PUBLIC',
      });
      expect(res.body.meta.requestId).toBeDefined();
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('executes successful compare-and-swap rotation and emits two Set-Cookie headers', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_refresh_test_1';
      const now = new Date();

      const { rawToken: rawRefresh, digest } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      const mockSession = {
        sessionId,
        userId,
        status: 'ACTIVE',
        generation: 1,
        currentRefreshDigest: digest,
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      };

      const mockUser = {
        _id: userId,
        emailNormalized: 'user@example.test',
        emailVerifiedAt: now,
        displayName: 'Test Candidate',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      };

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue(mockSession as unknown as SessionDocument);
      vi.spyOn(UserModel, 'findById').mockResolvedValue(mockUser as unknown as UserDocument);
      vi.spyOn(SessionModel, 'findOneAndUpdate').mockResolvedValue({
        ...mockSession,
        generation: 2,
      } as unknown as SessionDocument);

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${rawRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.tokenType).toBe('Bearer');
      expect(res.body.data.user.id).toBe(String(userId));
      expect(res.body.data.session.id).toBe(sessionId);

      // Verify two separate Set-Cookie headers
      const setCookies = res.headers['set-cookie'];
      expect(Array.isArray(setCookies)).toBe(true);
      expect(setCookies.length).toBe(2);
      expect(setCookies[0]).toContain('roundset_refresh=');
      expect(setCookies[0]).toContain('HttpOnly');
      expect(setCookies[1]).toContain('roundset_csrf=');
      expect(setCookies[1]).not.toContain('HttpOnly');
    });

    it('rejects forged refresh MAC with 401 AUTH_REQUIRED without revoking session or auditing replay', async () => {
      const sessionId = 'sess_forged_mac_1';
      const { rawToken } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      // Tamper with MAC
      const parts = rawToken.split('.');
      parts[5] = 'bad_mac_' + parts[5];
      const forgedRefresh = parts.join('.');

      const findSessionSpy = vi.spyOn(SessionModel, 'findOne');
      const updateSessionSpy = vi.spyOn(SessionModel, 'updateOne');
      const auditSpy = vi.spyOn(SecurityAuditEventModel, 'create');

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${forgedRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');

      // Crucial security invariant: Forged MAC must never touch session or trigger family revocation
      expect(findSessionSpy).not.toHaveBeenCalled();
      expect(updateSessionSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('detects authentic stale generation replay, revokes session family, logs audit event, and returns 401 SESSION_REPLAY_DETECTED', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_replay_test_1';
      const now = new Date();

      // Token generated with generation 1
      const { rawToken: staleRefresh } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      // Database session is already at generation 2 (i.e. token was previously rotated)
      const mockSession = {
        sessionId,
        userId,
        status: 'ACTIVE',
        generation: 2,
        currentRefreshDigest: 'digest_of_generation_2',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      };

      const mockUser = {
        _id: userId,
        emailNormalized: 'user@example.test',
        emailVerifiedAt: now,
        displayName: 'Test Candidate',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      };

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue(mockSession as unknown as SessionDocument);
      vi.spyOn(UserModel, 'findById').mockResolvedValue(mockUser as unknown as UserDocument);
      const updateSessionSpy = vi
        .spyOn(SessionModel, 'updateOne')
        .mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      const auditSpy = vi
        .spyOn(SecurityAuditEventModel, 'create')
        .mockResolvedValue({} as unknown as SecurityAuditEventDocument);

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${staleRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_REPLAY_DETECTED');

      // Family revocation executed
      expect(updateSessionSpy).toHaveBeenCalledWith(
        { sessionId, status: 'ACTIVE' },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'REVOKED',
            revokedReason: 'SESSION_REPLAY_DETECTED',
          }),
        })
      );

      // Audit event created
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'SESSION_REPLAY_DETECTED',
          outcome: 'FAILURE',
          reasonCode: 'STALE_GENERATION_REPLAY',
        })
      );
    });

    it('rejects cross-session CSRF token mismatch with 403 Forbidden', async () => {
      const sessionIdA = 'sess_refresh_A';
      const sessionIdB = 'sess_refresh_B';

      const { rawToken: refreshA } = createRefreshToken(keyring, {
        sessionId: sessionIdA,
        generation: 1,
      });
      // CSRF token bound to session B
      const csrfB = createCsrfToken(keyring, { sessionId: sessionIdB });

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${refreshA}; roundset_csrf=${csrfB}`)
        .set('X-CSRF-Token', csrfB)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects refresh when session is already revoked or expired', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_already_revoked';
      const { rawToken } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'REVOKED',
        generation: 1,
      } as unknown as SessionDocument);

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${rawToken}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('concurrent refresh requests result in exactly one successful successor commit', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_concurrency_race';
      const now = new Date();

      const { rawToken: rawRefresh, digest } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      const mockSession = {
        sessionId,
        userId,
        status: 'ACTIVE',
        generation: 1,
        currentRefreshDigest: digest,
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      };

      const mockUser = {
        _id: userId,
        emailNormalized: 'user@example.test',
        emailVerifiedAt: now,
        displayName: 'Test Candidate',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      };

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue(mockSession as unknown as SessionDocument);
      vi.spyOn(UserModel, 'findById').mockResolvedValue(mockUser as unknown as UserDocument);

      // Simulate atomic CAS: first caller succeeds, subsequent concurrent calls return null
      let commitCount = 0;
      vi.spyOn(SessionModel, 'findOneAndUpdate').mockImplementation(async () => {
        if (commitCount === 0) {
          commitCount++;
          return { ...mockSession, generation: 2 } as unknown as SessionDocument;
        }
        return null;
      });

      const makeRequest = () =>
        request(app)
          .post('/api/v1/auth/refresh')
          .set('Origin', allowedOrigin)
          .set('Cookie', `roundset_refresh=${rawRefresh}; roundset_csrf=${csrfToken}`)
          .set('X-CSRF-Token', csrfToken)
          .send({});

      const [res1, res2] = await Promise.all([makeRequest(), makeRequest()]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(200);
      expect(statuses).toContain(401);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('revokes session and clears both cookies on cookie-primary logout', async () => {
      const sessionId = 'sess_logout_1';
      const { rawToken: rawRefresh } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        status: 'ACTIVE',
      } as unknown as SessionDocument);
      const updateSpy = vi
        .spyOn(SessionModel, 'updateOne')
        .mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${rawRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(204);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(updateSpy).toHaveBeenCalledWith(
        { sessionId, status: 'ACTIVE' },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'REVOKED',
            revokedReason: 'USER_LOGOUT',
          }),
        })
      );

      const setCookies = res.headers['set-cookie'];
      expect(setCookies.length).toBe(2);
      expect(setCookies[0]).toContain('Max-Age=0');
      expect(setCookies[1]).toContain('Max-Age=0');
    });

    it('an expired Bearer token does not block valid cookie-primary logout', async () => {
      const sessionId = 'sess_logout_2';
      const { rawToken: rawRefresh } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      // Construct an expired Bearer token
      const { key, kid } = keyring.getJwtSigningKey();
      const expiredBearer = await new jose.SignJWT({
        sid: sessionId,
        epoch: 1,
      })
        .setSubject('507f1f77bcf86cd799439011')
        .setProtectedHeader({ alg: 'EdDSA', kid })
        .setIssuer('roundset-auth')
        .setAudience('roundset-api')
        .setJti('jti_exp')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 2000)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 1000)
        .sign(key);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        status: 'ACTIVE',
      } as unknown as SessionDocument);
      vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${expiredBearer}`)
        .set('Cookie', `roundset_refresh=${rawRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(204);
    });

    it('a valid Bearer for a DIFFERENT session causes 403 FORBIDDEN, NO server revocation, and NO cookie clearing', async () => {
      const sessionIdA = 'sess_cookie_A';
      const sessionIdB = 'sess_bearer_B';

      const { rawToken: rawRefresh } = createRefreshToken(keyring, {
        sessionId: sessionIdA,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId: sessionIdA });

      // Valid Bearer for session B
      const validBearerB = await signAccessToken(keyring, {
        userId: '507f1f77bcf86cd799439011',
        sessionId: sessionIdB,
        epoch: 1,
      });

      const updateSpy = vi.spyOn(SessionModel, 'updateOne');

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${validBearerB}`)
        .set('Cookie', `roundset_refresh=${rawRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toContain('Logout credential and session mismatch');

      // Crucial: No server revocation and no cookie clearing
      expect(updateSpy).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('returns 404 NOT_FOUND when target session is nonexistent', async () => {
      const sessionId = 'sess_nonexistent';
      const { rawToken: rawRefresh } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${rawRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('supports Bearer-only logout when cookies are absent', async () => {
      const sessionId = 'sess_bearer_only';
      const bearer = await signAccessToken(keyring, {
        userId: '507f1f77bcf86cd799439011',
        sessionId,
        epoch: 1,
      });

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        status: 'ACTIVE',
      } as unknown as SessionDocument);
      const updateSpy = vi
        .spyOn(SessionModel, 'updateOne')
        .mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(204);
      expect(updateSpy).toHaveBeenCalledWith(
        { sessionId, status: 'ACTIVE' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'REVOKED' }),
        })
      );
    });

    it('preserves revokedReason LOGOUT_ALL and terminal status when single-session logout follows logout-all', async () => {
      const sessionId = 'sess_already_logout_all';
      const bearer = await signAccessToken(keyring, {
        userId: '507f1f77bcf86cd799439011',
        sessionId,
        epoch: 2,
      });

      // Session is already in terminal state with revokedReason: 'LOGOUT_ALL'
      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        status: 'REVOKED',
        revokedReason: 'LOGOUT_ALL',
        revokedAt: new Date(Date.now() - 10000),
      } as unknown as SessionDocument);

      const updateSpy = vi.spyOn(SessionModel, 'updateOne');

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(204);
      // Terminal metadata must NOT be overwritten
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('cannot erase SESSION_REPLAY_DETECTED or other previously persisted security reason', async () => {
      const sessionId = 'sess_replay_detected_terminal';
      const bearer = await signAccessToken(keyring, {
        userId: '507f1f77bcf86cd799439011',
        sessionId,
        epoch: 1,
      });

      // Session has security replay detected
      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        status: 'REVOKED',
        revokedReason: 'SESSION_REPLAY_DETECTED',
        revokedAt: new Date(Date.now() - 5000),
      } as unknown as SessionDocument);

      const updateSpy = vi.spyOn(SessionModel, 'updateOne');

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(204);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('remains idempotent on repeated logout calls without overwriting terminal status', async () => {
      const sessionId = 'sess_idempotent_logout';
      const { rawToken: rawRefresh } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      // First call finds ACTIVE session; second call finds REVOKED session
      vi.spyOn(SessionModel, 'findOne')
        .mockResolvedValueOnce({
          sessionId,
          status: 'ACTIVE',
        } as unknown as SessionDocument)
        .mockResolvedValueOnce({
          sessionId,
          status: 'REVOKED',
          revokedReason: 'USER_LOGOUT',
        } as unknown as SessionDocument);

      const updateSpy = vi
        .spyOn(SessionModel, 'updateOne')
        .mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      // Call 1
      const res1 = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${rawRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res1.status).toBe(204);
      expect(updateSpy).toHaveBeenCalledTimes(1);

      // Call 2
      const res2 = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${rawRefresh}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res2.status).toBe(204);
      // updateOne must NOT be called again
      expect(updateSpy).toHaveBeenCalledTimes(1);
      // Cookies are still cleared
      expect(res2.headers['set-cookie']).toBeDefined();
    });
  });

  describe('POST /api/v1/auth/logout-all', () => {
    it('increments user sessionEpoch, revokes all active sessions for the user, and clears cookies', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_active_valid_logout_all';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const sessionUpdateSpy = vi
        .spyOn(SessionModel, 'updateOne')
        .mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      const userUpdateSpy = vi
        .spyOn(UserModel, 'updateOne')
        .mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      const sessionUpdateManySpy = vi
        .spyOn(SessionModel, 'updateMany')
        .mockResolvedValue({ modifiedCount: 3, acknowledged: true, matchedCount: 3, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(204);

      // Verifies initiating session write fence
      expect(sessionUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          userId,
          status: 'ACTIVE',
          epochAtIssue: 1,
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'REVOKED',
            revokedReason: 'LOGOUT_ALL',
          }),
        }),
        { session: expect.anything() }
      );

      // Verifies conditional epoch increment
      expect(userUpdateSpy).toHaveBeenCalledWith(
        { _id: userId, sessionEpoch: 1, accountStatus: 'ACTIVE' },
        { $inc: { sessionEpoch: 1 } },
        { session: expect.anything() }
      );

      // Verifies revocation of all sessions
      expect(sessionUpdateManySpy).toHaveBeenCalledWith(
        { userId, status: 'ACTIVE' },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'REVOKED',
            revokedReason: 'LOGOUT_ALL',
          }),
        }),
        { session: expect.anything() }
      );

      const setCookies = res.headers['set-cookie'];
      expect(setCookies.length).toBe(2);
      expect(setCookies[0]).toContain('Max-Age=0');
      expect(setCookies[1]).toContain('Max-Age=0');
    });

    it('R1: rejects logout-all when session is revoked', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_revoked_logout_all';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'REVOKED',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne');
      const sessionUpdateManySpy = vi.spyOn(SessionModel, 'updateMany');

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
      expect(userUpdateSpy).not.toHaveBeenCalled();
      expect(sessionUpdateManySpy).not.toHaveBeenCalled();
    });

    it('R1: rejects logout-all when session is expired', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_expired_logout_all';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() - 1000), // Expired idle
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne');

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(401);
      expect(userUpdateSpy).not.toHaveBeenCalled();
    });

    it('R1: rejects logout-all when session belongs to a foreign user', async () => {
      const userId = new Types.ObjectId();
      const foreignUserId = new Types.ObjectId();
      const sessionId = 'sess_foreign_logout_all';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId: foreignUserId, // Belongs to different user
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne');

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(401);
      expect(userUpdateSpy).not.toHaveBeenCalled();
    });

    it('R1: rejects logout-all when session epoch is stale', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_stale_epoch_logout_all';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 2, // Session epoch does not match token epoch
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne');

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(401);
      expect(userUpdateSpy).not.toHaveBeenCalled();
    });

    it('rejects logout-all without Bearer token with 401 AUTH_REQUIRED', async () => {
      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('R3 — Production Cookie Namespace Enforcement', () => {
    it('rejects development cookie names in production environment', async () => {
      const prodEnv = loadEnv({
        NODE_ENV: 'test',
        WEB_ORIGIN: allowedOrigin,
        INGRESS_MODE: 'SINGLE_ORIGIN',
        MOCK_DATABASE: 'false',
        POLICY_ID: 'roundset-prod-policy',
        POLICY_CONSENT_VERSION: 'v2026.11.23',
      });

      // Override isProduction in route options via custom route mounting or testing with isProduction = true
      const { rawToken } = createRefreshToken(keyring, {
        sessionId: 'sess_prod_cookie_test',
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, {
        sessionId: 'sess_prod_cookie_test',
      });

      // App mounted with isProduction=true (simulated by passing custom router or test app)
      const prodAppWithFlag = createApp({
        env: { ...prodEnv, NODE_ENV: 'production' } as unknown as ReturnType<typeof loadEnv>,
        sessionService,
        readinessProvider: new MockReadinessProvider(true),
      });

      // Sending development unprefixed cookie names (roundset_refresh, roundset_csrf)
      const res = await request(prodAppWithFlag)
        .post('/api/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', `roundset_refresh=${rawToken}; roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      // In production, unprefixed cookies are completely ignored; yields 401
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('accepts __Host- cookies in production environment', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_prod_host_cookie_test';
      const now = new Date();

      const { rawToken, digest } = createRefreshToken(keyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(keyring, { sessionId });

      const prodEnv = loadEnv({
        NODE_ENV: 'test',
        WEB_ORIGIN: allowedOrigin,
        INGRESS_MODE: 'SINGLE_ORIGIN',
        MOCK_DATABASE: 'false',
        POLICY_ID: 'roundset-prod-policy',
        POLICY_CONSENT_VERSION: 'v2026.11.23',
      });

      const prodApp = createApp({
        env: { ...prodEnv, NODE_ENV: 'production' } as unknown as ReturnType<typeof loadEnv>,
        sessionService,
        readinessProvider: new MockReadinessProvider(true),
      });

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        generation: 1,
        currentRefreshDigest: digest,
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        emailNormalized: 'user@example.test',
        displayName: 'Test User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOneAndUpdate').mockResolvedValue({
        sessionId,
        generation: 2,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const res = await request(prodApp)
        .post('/api/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', `__Host-roundset_refresh=${rawToken}; __Host-roundset_csrf=${csrfToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.session.id).toBe(sessionId);
    });
  });

  describe('R2-02 — Strict Empty Object {} Request Validation', () => {
    const endpoints = [
      { name: '/api/v1/auth/refresh', path: '/api/v1/auth/refresh' },
      { name: '/api/v1/auth/logout', path: '/api/v1/auth/logout' },
      { name: '/api/v1/auth/logout-all', path: '/api/v1/auth/logout-all' },
    ];

    for (const ep of endpoints) {
      it(`rejects array body [] on ${ep.name} with 400 INVALID_INPUT`, async () => {
        const res = await request(app)
          .post(ep.path)
          .set('Origin', allowedOrigin)
          .send([]);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_INPUT');
        expect(res.body.error.message).toContain('Request body must be an empty JSON object {}');
      });

      it(`rejects object with unknown keys on ${ep.name} with 400 INVALID_INPUT`, async () => {
        const res = await request(app)
          .post(ep.path)
          .set('Origin', allowedOrigin)
          .send({ unknownField: 'forbidden' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_INPUT');
        expect(res.body.error.message).toContain('Request body must be an empty JSON object {}');
      });

      it(`rejects string primitive body on ${ep.name} with 400 INVALID_INPUT`, async () => {
        const res = await request(app)
          .post(ep.path)
          .set('Origin', allowedOrigin)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify('plain-string-payload'));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_INPUT');
      });

      it(`rejects null body on ${ep.name} with 400 INVALID_INPUT`, async () => {
        const res = await request(app)
          .post(ep.path)
          .set('Origin', allowedOrigin)
          .set('Content-Type', 'application/json')
          .send('null');

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_INPUT');
      });

      it(`rejects missing request body on ${ep.name} with 400 INVALID_INPUT`, async () => {
        const res = await request(app)
          .post(ep.path)
          .set('Origin', allowedOrigin)
          .send();

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_INPUT');
        expect(res.body.error.message).toContain('Request body must be an empty JSON object {}');
      });
    }
  });

  describe('R2-03 — Atomic Logout-All Persistence, Session Fence, and Transactional Fault Handling', () => {
    it('rejects logout-all when transaction session is unavailable with 503 and zero writes', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_unavailable_zero_writes';
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      // Disconnected state -> readyState = 0
      Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true, writable: true });

      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne');
      const sessionUpdateSpy = vi.spyOn(SessionModel, 'updateOne');
      const sessionUpdateManySpy = vi.spyOn(SessionModel, 'updateMany');

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(userUpdateSpy).not.toHaveBeenCalled();
      expect(sessionUpdateSpy).not.toHaveBeenCalled();
      expect(sessionUpdateManySpy).not.toHaveBeenCalled();
    });

    it('rejects logout-all when transaction session creation throws with 503 and zero writes', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_creation_throws_zero_writes';
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(mongoose.connection, 'startSession').mockRejectedValue(
        new Error('MongoServerError: Transaction numbers are only allowed on a replica set member')
      );

      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne');
      const sessionUpdateSpy = vi.spyOn(SessionModel, 'updateOne');
      const sessionUpdateManySpy = vi.spyOn(SessionModel, 'updateMany');

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(userUpdateSpy).not.toHaveBeenCalled();
      expect(sessionUpdateSpy).not.toHaveBeenCalled();
      expect(sessionUpdateManySpy).not.toHaveBeenCalled();
    });

    it('sanitizes public database errors without exposing sensitive connection strings or internal details', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_sensitive_error_leak_test';
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      const sensitiveInternalError = new Error(
        'MongoServerSelectionError: connection failed to mongodb://admin_user:SuperSecretPassword123@internal-db-node-01.corp.roundset.internal:27017/roundset_prod?authSource=admin&replicaSet=rs0'
      );
      vi.spyOn(mongoose.connection, 'startSession').mockRejectedValue(sensitiveInternalError);

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.message).toBe('Database transactions are unavailable');

      // Assert that no sensitive substring appears anywhere in the HTTP response
      const responseText = JSON.stringify(res.body) + (res.text ?? '');
      expect(responseText).not.toContain('SuperSecretPassword123');
      expect(responseText).not.toContain('internal-db-node-01');
      expect(responseText).not.toContain('roundset.internal');
      expect(responseText).not.toContain('roundset_prod');
      expect(responseText).not.toContain('27017');
      expect(responseText).not.toContain('mongodb://');
      expect(responseText).not.toContain('admin_user');
      expect(responseText).not.toContain('MongoServerSelectionError');
    });

    it('returns 503 SERVICE_UNAVAILABLE and zero writes when standalone topology rejects first transactional operation', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_standalone_first_op_fail';
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      let inTx = false;
      let aborted = false;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => { inTx = false; }),
        abortTransaction: vi.fn(async () => { inTx = false; aborted = true; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };

      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);

      // Standalone MongoDB accepted startTransaction() locally, but rejects the first transactional write
      const standaloneError = new Error('Transaction numbers are only allowed on a replica set member or mongos');
      (standaloneError as unknown as { code: number; codeName: string }).code = 20;
      (standaloneError as unknown as { code: number; codeName: string }).codeName = 'IllegalOperation';

      // First transactional operation is initiating session write-fence: SessionModel.updateOne
      const sessionFenceSpy = vi.spyOn(SessionModel, 'updateOne').mockRejectedValue(standaloneError);
      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne');
      const sessionUpdateManySpy = vi.spyOn(SessionModel, 'updateMany');

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.message).toBe('Database transactions are not supported');
      expect(sessionFenceSpy).toHaveBeenCalled();
      expect(mockClientSession.abortTransaction).toHaveBeenCalled();
      expect(aborted).toBe(true);
      expect(mockClientSession.endSession).toHaveBeenCalled();

      // Zero successful state mutations: user epoch CAS and updateMany must NOT be executed
      expect(userUpdateSpy).not.toHaveBeenCalled();
      expect(sessionUpdateManySpy).not.toHaveBeenCalled();
    });

    it('preserves ordinary unexpected database errors during first transactional operation as 500 server error', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_ordinary_db_error';
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      let inTx = false;
      let aborted = false;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => { inTx = false; }),
        abortTransaction: vi.fn(async () => { inTx = false; aborted = true; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };

      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);

      // Ordinary unexpected database error (e.g. disk or connection dropped), NOT an unsupported transaction error
      const diskError = new Error('I/O error reading database catalog');
      vi.spyOn(SessionModel, 'updateOne').mockRejectedValue(diskError);

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      // Ordinary unexpected failure must be preserved as 500 server error, not 503
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(mockClientSession.abortTransaction).toHaveBeenCalled();
      expect(aborted).toBe(true);
      expect(mockClientSession.endSession).toHaveBeenCalled();
    });

    it('rolls back all mutations if session revocation fails after epoch update', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_rollback_test';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      let inTx = false;
      let aborted = false;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => { inTx = false; }),
        abortTransaction: vi.fn(async () => { inTx = false; aborted = true; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };

      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);
      vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(UserModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      // Inject failure on session revocation inside transaction
      vi.spyOn(SessionModel, 'updateMany').mockRejectedValue(new Error('Simulated database write failure during session revocation'));

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(500);
      expect(mockClientSession.startTransaction).toHaveBeenCalled();
      expect(mockClientSession.abortTransaction).toHaveBeenCalled();
      expect(aborted).toBe(true);
      expect(mockClientSession.endSession).toHaveBeenCalled();
    });

    it('aborts without updating user epoch or other sessions when concurrent single-session logout wins before session fence', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_race_single_logout_wins';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      let inTx = false;
      let aborted = false;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => { inTx = false; }),
        abortTransaction: vi.fn(async () => { inTx = false; aborted = true; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };
      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);

      // Single-session logout already revoked the initiating session before logout-all's fence write
      // So the conditional update matches 0 documents
      vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({
        matchedCount: 0,
        modifiedCount: 0,
        acknowledged: true,
        upsertedCount: 0,
        upsertedId: null,
      });

      // Inspection query finds the session is already revoked
      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'REVOKED',
        revokedReason: 'USER_LOGOUT',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne');
      const sessionUpdateManySpy = vi.spyOn(SessionModel, 'updateMany');

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
      expect(res.body.error.message).toContain('Session is not active');
      expect(aborted).toBe(true);
      expect(userUpdateSpy).not.toHaveBeenCalled();
      expect(sessionUpdateManySpy).not.toHaveBeenCalled();
    });

    it('logout-all wins before single-session logout and subsequent single logout completes cleanly', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_race_logout_all_wins';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const sessionUpdateSpy = vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({
        modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null
      });
      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne').mockResolvedValue({
        modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null
      });
      const sessionUpdateManySpy = vi.spyOn(SessionModel, 'updateMany').mockResolvedValue({
        modifiedCount: 2, acknowledged: true, matchedCount: 2, upsertedCount: 0, upsertedId: null
      });

      // 1. Logout-all runs and wins
      const resLogoutAll = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(resLogoutAll.status).toBe(204);
      expect(sessionUpdateSpy).toHaveBeenCalled();
      expect(userUpdateSpy).toHaveBeenCalled();
      expect(sessionUpdateManySpy).toHaveBeenCalled();

      // 2. Subsequent single-session logout runs for the same session (now already revoked by logout-all)
      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'REVOKED',
        revokedReason: 'LOGOUT_ALL',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const resLogout = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(resLogout.status).toBe(204);
      // updateOne must NOT be called during single logout, preserving revokedReason: 'LOGOUT_ALL'
      expect(sessionUpdateSpy).toHaveBeenCalledTimes(1);
    });

    it('handles unknown commit followed by successful commit retry', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_retry_success';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      const uncertainError = new Error('Transient commit network error');
      (uncertainError as unknown as { errorLabels: string[] }).errorLabels = ['UnknownTransactionCommitResult'];

      let inTx = false;
      let commitCalls = 0;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => {
          commitCalls++;
          if (commitCalls === 1) {
            throw uncertainError;
          }
          inTx = false;
        }),
        abortTransaction: vi.fn(async () => { inTx = false; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };

      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);
      vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(UserModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(SessionModel, 'updateMany').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(204);
      expect(commitCalls).toBe(2);
      expect(mockClientSession.endSession).toHaveBeenCalled();
    });

    it('rejects logout-all when commit is uncertain and session revocation is incomplete despite unrelated epoch bump', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_unrelated_bump_incomplete';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      // First findById succeeds with epoch 1
      // Second findById during reconciliation finds epoch 2 (unrelated bump!)
      vi.spyOn(UserModel, 'findById')
        .mockResolvedValueOnce({
          _id: userId,
          role: 'CANDIDATE',
          accountStatus: 'ACTIVE',
          sessionEpoch: 1,
        } as unknown as UserDocument)
        .mockResolvedValueOnce({
          _id: userId,
          role: 'CANDIDATE',
          accountStatus: 'ACTIVE',
          sessionEpoch: 2,
        } as unknown as UserDocument);

      // Initiating session was NOT revoked with LOGOUT_ALL, or other active sessions remain
      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE', // Still ACTIVE! Session revocation was NOT durable
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      vi.spyOn(SessionModel, 'countDocuments').mockResolvedValue(2); // 2 active sessions remain!

      const uncertainError = new Error('Permanent network timeout during commit');
      (uncertainError as unknown as { errorLabels: string[] }).errorLabels = ['UnknownTransactionCommitResult'];

      let inTx = false;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => {
          throw uncertainError;
        }),
        abortTransaction: vi.fn(async () => { inTx = false; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };

      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);
      vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(UserModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(SessionModel, 'updateMany').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      // Must NOT return 204 success!
      expect(res.status).toBe(500);
      expect(mockClientSession.endSession).toHaveBeenCalled();
    });

    it('handles uncertain commit outcome gracefully when durable state is fully reconciled', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_uncertain_commit_reconciled';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      const findUserSpy = vi.spyOn(UserModel, 'findById')
        .mockResolvedValueOnce({
          _id: userId,
          role: 'CANDIDATE',
          accountStatus: 'ACTIVE',
          sessionEpoch: 1,
        } as unknown as UserDocument)
        // Second call during reconciliation finds epoch was incremented
        .mockResolvedValueOnce({
          _id: userId,
          role: 'CANDIDATE',
          accountStatus: 'ACTIVE',
          sessionEpoch: 2,
        } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'REVOKED',
        revokedReason: 'LOGOUT_ALL',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      // Reconciliation verifies 0 remaining active sessions
      vi.spyOn(SessionModel, 'countDocuments').mockResolvedValue(0);

      const uncertainError = new Error('Network timeout during commit');
      (uncertainError as unknown as { errorLabels: string[] }).errorLabels = ['UnknownTransactionCommitResult'];

      let inTx = false;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => {
          inTx = false;
          throw uncertainError;
        }),
        abortTransaction: vi.fn(async () => { inTx = false; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };

      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);
      vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(UserModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(SessionModel, 'updateMany').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(204);
      expect(findUserSpy).toHaveBeenCalledTimes(2);
      expect(mockClientSession.endSession).toHaveBeenCalled();
    });

    it('prevents duplicate epoch bump on concurrent logout-all requests', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_concurrent_logout_all';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

      vi.spyOn(SessionModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(SessionModel, 'updateMany').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      // First call succeeds (modifiedCount: 1), second call fails CAS (modifiedCount: 0)
      const userUpdateSpy = vi.spyOn(UserModel, 'updateOne')
        .mockResolvedValueOnce({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null })
        .mockResolvedValueOnce({ modifiedCount: 0, acknowledged: true, matchedCount: 0, upsertedCount: 0, upsertedId: null });

      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/v1/auth/logout-all')
          .set('Origin', allowedOrigin)
          .set('Authorization', `Bearer ${bearer}`)
          .send({}),
        request(app)
          .post('/api/v1/auth/logout-all')
          .set('Origin', allowedOrigin)
          .set('Authorization', `Bearer ${bearer}`)
          .send({}),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([204, 401]);
      // user update was called for both, but only one succeeded in incrementing epoch
      expect(userUpdateSpy).toHaveBeenCalledTimes(2);
    });
  });
});
