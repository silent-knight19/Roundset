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
        { sessionId },
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
        { sessionId },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'REVOKED' }),
        })
      );
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

      // Verifies conditional epoch increment
      expect(userUpdateSpy).toHaveBeenCalledWith(
        { _id: userId, sessionEpoch: 1, accountStatus: 'ACTIVE' },
        { $inc: { sessionEpoch: 1 } }
      );

      // Verifies revocation of all sessions
      expect(sessionUpdateManySpy).toHaveBeenCalledWith(
        { userId, status: 'ACTIVE' },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'REVOKED',
            revokedReason: 'LOGOUT_ALL',
          }),
        })
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

  describe('R2-03 — Atomic Logout-All Persistence and Transactional Fault Handling', () => {
    it('aborts transaction and rolls back when session revocation fails after epoch increment', async () => {
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

    it('rejects concurrent logout-all when user epoch CAS detects modifiedCount !== 1', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_cas_conflict';
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

      let aborted = false;
      let inTx = false;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => { inTx = false; }),
        abortTransaction: vi.fn(async () => { inTx = false; aborted = true; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };

      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);

      // CAS conflict: another concurrent transaction already bumped the epoch
      vi.spyOn(UserModel, 'updateOne').mockResolvedValue({ modifiedCount: 0, acknowledged: true, matchedCount: 0, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
      expect(aborted).toBe(true);
    });

    it('handles uncertain commit outcome gracefully when user epoch was incremented on server', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_uncertain_commit_success';
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
        // Second call during uncertain commit recovery finds that epoch was indeed incremented on server
        .mockResolvedValueOnce({
          _id: userId,
          role: 'CANDIDATE',
          accountStatus: 'ACTIVE',
          sessionEpoch: 2,
        } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      } as unknown as SessionDocument);

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

    it('rethrows uncertain commit error when user epoch was NOT incremented on server', async () => {
      const userId = new Types.ObjectId();
      const sessionId = 'sess_tx_uncertain_commit_fail';
      const now = new Date();
      const bearer = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      vi.spyOn(UserModel, 'findById')
        .mockResolvedValueOnce({
          _id: userId,
          role: 'CANDIDATE',
          accountStatus: 'ACTIVE',
          sessionEpoch: 1,
        } as unknown as UserDocument)
        // Second call finds epoch was NOT incremented on server
        .mockResolvedValueOnce({
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

      const uncertainError = new Error('Network timeout during commit');
      (uncertainError as unknown as { errorLabels: string[] }).errorLabels = ['UnknownTransactionCommitResult'];

      let inTx = false;
      let aborted = false;
      const mockClientSession = {
        startTransaction: vi.fn(() => { inTx = true; }),
        commitTransaction: vi.fn(async () => {
          throw uncertainError;
        }),
        abortTransaction: vi.fn(async () => { inTx = false; aborted = true; }),
        endSession: vi.fn(async () => {}),
        inTransaction: vi.fn(() => inTx),
      };

      vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(mockClientSession as unknown as mongoose.ClientSession);
      vi.spyOn(UserModel, 'updateOne').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });
      vi.spyOn(SessionModel, 'updateMany').mockResolvedValue({ modifiedCount: 1, acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null });

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Origin', allowedOrigin)
        .set('Authorization', `Bearer ${bearer}`)
        .send({});

      expect(res.status).toBe(500);
      expect(aborted).toBe(true);
      expect(mockClientSession.endSession).toHaveBeenCalled();
    });
  });
});
