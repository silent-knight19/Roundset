import { describe, it, expect, beforeEach } from 'vitest';
import * as jose from 'jose';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { loadEnv } from '../src/config/env.js';
import {
  SessionKeyring,
  signAccessToken,
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from '../src/modules/auth/session/index.js';
import { UnauthorizedError } from '../src/core/errors.js';
import type { UserDocument, SessionDocument } from '../src/modules/identity/models/index.js';

describe('P2-AUTH-05a: Ed25519 Access JWT Verification Suite', () => {
  let keyring: SessionKeyring;

  beforeEach(async () => {
    const config = loadEnv({
      NODE_ENV: 'test',
      JWT_ISSUER: 'roundset-auth-test',
      JWT_AUDIENCE: 'roundset-api-test',
      JWT_ACTIVE_KID: 'jwt-k1',
      MOCK_DATABASE: 'false',
    });
    keyring = new SessionKeyring(config);
    await keyring.initialize();
  });

  it('signs and verifies a valid Ed25519 access JWT with required claims', async () => {
    const token = await signAccessToken(keyring, {
      userId: '507f1f77bcf86cd799439011',
      sessionId: 'sess_valid_123',
      epoch: 1,
    });

    expect(typeof token).toBe('string');

    const payload = await verifyAccessToken(keyring, token);
    expect(payload.sub).toBe('507f1f77bcf86cd799439011');
    expect(payload.sid).toBe('sess_valid_123');
    expect(payload.epoch).toBe(1);
    expect(payload.iss).toBe('roundset-auth-test');
    expect(payload.aud).toBe('roundset-api-test');
    expect(typeof payload.jti).toBe('string');
    expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('rejects tokens signed with invalid algorithms (e.g. HS256 / none)', async () => {
    // Generate an HMAC token with the same claims but HS256
    const secret = new TextEncoder().encode('some-symmetric-secret-key-32chars!');
    const fakeToken = await new jose.SignJWT({
      sid: 'sess_123',
      epoch: 1,
    })
      .setSubject('507f1f77bcf86cd799439011')
      .setProtectedHeader({ alg: 'HS256', kid: 'jwt-k1' })
      .setIssuer('roundset-auth-test')
      .setAudience('roundset-api-test')
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(secret);

    await expect(verifyAccessToken(keyring, fakeToken)).rejects.toThrow(
      'Invalid access token algorithm'
    );
  });

  it('rejects expired access JWTs', async () => {
    const { key, kid } = keyring.getJwtSigningKey();
    const expiredToken = await new jose.SignJWT({
      sid: 'sess_123',
      epoch: 1,
    })
      .setSubject('507f1f77bcf86cd799439011')
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuer('roundset-auth-test')
      .setAudience('roundset-api-test')
      .setJti(crypto.randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 400)
      .sign(key);

    await expect(verifyAccessToken(keyring, expiredToken)).rejects.toThrow(
      'Access token has expired'
    );
  });

  it('rejects tokens with wrong audience', async () => {
    const { key, kid } = keyring.getJwtSigningKey();
    const wrongAudToken = await new jose.SignJWT({
      sid: 'sess_123',
      epoch: 1,
    })
      .setSubject('507f1f77bcf86cd799439011')
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuer('roundset-auth-test')
      .setAudience('foreign-api')
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);

    await expect(verifyAccessToken(keyring, wrongAudToken)).rejects.toThrow(
      'Access token signature verification failed'
    );
  });

  it('rejects tokens with wrong issuer', async () => {
    const { key, kid } = keyring.getJwtSigningKey();
    const wrongIssToken = await new jose.SignJWT({
      sid: 'sess_123',
      epoch: 1,
    })
      .setSubject('507f1f77bcf86cd799439011')
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuer('foreign-issuer')
      .setAudience('roundset-api-test')
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);

    await expect(verifyAccessToken(keyring, wrongIssToken)).rejects.toThrow(
      'Access token signature verification failed'
    );
  });

  it('rejects tokens with unknown kid', async () => {
    const { key } = keyring.getJwtSigningKey();
    const unknownKidToken = await new jose.SignJWT({
      sid: 'sess_123',
      epoch: 1,
    })
      .setSubject('507f1f77bcf86cd799439011')
      .setProtectedHeader({ alg: 'EdDSA', kid: 'unknown-k999' })
      .setIssuer('roundset-auth-test')
      .setAudience('roundset-api-test')
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);

    await expect(verifyAccessToken(keyring, unknownKidToken)).rejects.toThrow(
      'Unknown access token key ID: unknown-k999'
    );
  });

  it('rejects malformed tokens and missing claims', async () => {
    await expect(verifyAccessToken(keyring, 'not-a-jwt')).rejects.toThrow(
      UnauthorizedError
    );

    const { key, kid } = keyring.getJwtSigningKey();
    // Missing 'sid' claim
    const missingSidToken = await new jose.SignJWT({
      epoch: 1,
    })
      .setSubject('507f1f77bcf86cd799439011')
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuer('roundset-auth-test')
      .setAudience('roundset-api-test')
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);

    await expect(verifyAccessToken(keyring, missingSidToken)).rejects.toThrow(
      'Access token contains malformed or missing claims'
    );
  });

  it('supports key rotation and verifies tokens signed with retired keys', async () => {
    // Generate an older keypair representing a retired key
    const { privateKey: oldPriv, publicKey: oldPub } = crypto.generateKeyPairSync('ed25519');
    const oldPrivPem = oldPriv.export({ type: 'pkcs8', format: 'pem' }).toString();
    const oldPubPem = oldPub.export({ type: 'spki', format: 'pem' }).toString();
    const oldKey = await jose.importPKCS8(oldPrivPem, 'EdDSA');

    // Register retired key in keyring
    await keyring.registerRetiredJwtKey('jwt-k0-retired', oldPubPem);

    // Sign a token with the old retired key
    const retiredKeyToken = await new jose.SignJWT({
      sid: 'sess_retired_123',
      epoch: 1,
    })
      .setSubject('507f1f77bcf86cd799439011')
      .setProtectedHeader({ alg: 'EdDSA', kid: 'jwt-k0-retired' })
      .setIssuer('roundset-auth-test')
      .setAudience('roundset-api-test')
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(oldKey);

    // Verification succeeds using the registered retired key
    const payload = await verifyAccessToken(keyring, retiredKeyToken);
    expect(payload.sid).toBe('sess_retired_123');
  });

  describe('R2: Bearer Principal and Session Binding in Middleware', () => {
    it('rejects when session.userId does not match user._id / payload.sub', async () => {
      const { createBearerAuthMiddleware } = await import('../src/modules/auth/session/middleware.js');
      const { SessionModel, UserModel } = await import('../src/modules/identity/models/index.js');
      const { Types } = await import('mongoose');

      const userId = new Types.ObjectId();
      const foreignUserId = new Types.ObjectId();
      const sessionId = 'sess_principal_mismatch';
      const token = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      const { vi } = await import('vitest');
      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId: foreignUserId, // Mismatch
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(Date.now() + 100000),
        absoluteExpiresAt: new Date(Date.now() + 100000),
      } as unknown as SessionDocument);

      const middleware = createBearerAuthMiddleware({ keyring });
      const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
      const res = {} as unknown as Response;
      let nextError: unknown;

      await middleware(req, res, ((err?: unknown) => {
        nextError = err;
      }) as unknown as (err?: unknown) => void);

      expect(nextError).toBeInstanceOf(UnauthorizedError);
      expect((nextError as UnauthorizedError).message).toContain('Session principal mismatch');
    });

    it('rejects when session.epochAtIssue does not match user.sessionEpoch', async () => {
      const { createBearerAuthMiddleware } = await import('../src/modules/auth/session/middleware.js');
      const { SessionModel, UserModel } = await import('../src/modules/identity/models/index.js');
      const { Types } = await import('mongoose');

      const userId = new Types.ObjectId();
      const sessionId = 'sess_epoch_mismatch';
      const token = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      const { vi } = await import('vitest');
      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        accountStatus: 'ACTIVE',
        sessionEpoch: 2, // User epoch bumped
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(Date.now() + 100000),
        absoluteExpiresAt: new Date(Date.now() + 100000),
      } as unknown as SessionDocument);

      const middleware = createBearerAuthMiddleware({ keyring });
      const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
      const res = {} as unknown as Response;
      let nextError: unknown;

      await middleware(req, res, ((err?: unknown) => {
        nextError = err;
      }) as unknown as (err?: unknown) => void);

      expect(nextError).toBeInstanceOf(UnauthorizedError);
      expect((nextError as UnauthorizedError).message).toContain('Session epoch mismatch');
    });

    it('rejects when session is revoked', async () => {
      const { createBearerAuthMiddleware } = await import('../src/modules/auth/session/middleware.js');
      const { SessionModel, UserModel } = await import('../src/modules/identity/models/index.js');
      const { Types } = await import('mongoose');

      const userId = new Types.ObjectId();
      const sessionId = 'sess_revoked';
      const token = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      const { vi } = await import('vitest');
      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      vi.spyOn(SessionModel, 'findOne').mockResolvedValue({
        sessionId,
        userId,
        status: 'REVOKED',
        epochAtIssue: 1,
        idleExpiresAt: new Date(Date.now() + 100000),
        absoluteExpiresAt: new Date(Date.now() + 100000),
      } as unknown as SessionDocument);

      const middleware = createBearerAuthMiddleware({ keyring });
      const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
      const res = {} as unknown as Response;
      let nextError: unknown;

      await middleware(req, res, ((err?: unknown) => {
        nextError = err;
      }) as unknown as (err?: unknown) => void);

      expect(nextError).toBeInstanceOf(UnauthorizedError);
      expect((nextError as UnauthorizedError).message).toContain('Session not active');
    });

    it('rejects when user accountStatus is not ACTIVE', async () => {
      const { createBearerAuthMiddleware } = await import('../src/modules/auth/session/middleware.js');
      const { UserModel } = await import('../src/modules/identity/models/index.js');
      const { Types } = await import('mongoose');

      const userId = new Types.ObjectId();
      const sessionId = 'sess_suspended_user';
      const token = await signAccessToken(keyring, {
        userId: String(userId),
        sessionId,
        epoch: 1,
      });

      const { vi } = await import('vitest');
      vi.spyOn(UserModel, 'findById').mockResolvedValue({
        _id: userId,
        accountStatus: 'SUSPENDED',
        sessionEpoch: 1,
      } as unknown as UserDocument);

      const middleware = createBearerAuthMiddleware({ keyring });
      const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
      const res = {} as unknown as Response;
      let nextError: unknown;

      await middleware(req, res, ((err?: unknown) => {
        nextError = err;
      }) as unknown as (err?: unknown) => void);

      expect(nextError).toBeInstanceOf(UnauthorizedError);
      expect((nextError as UnauthorizedError).message).toContain('User account not active');
    });
  });

  describe('R6: Production Test Fixture Isolation', () => {
    it('strictly forbids createSessionFixture in production environment', async () => {
      const { SessionService } = await import('../src/modules/auth/session/session.service.js');
      const prodConfig = loadEnv({
        NODE_ENV: 'test',
        MOCK_DATABASE: 'false',
      });
      const prodService = new SessionService(
        { ...prodConfig, NODE_ENV: 'production' } as unknown as ReturnType<typeof loadEnv>,
        keyring
      );

      await expect(prodService.createSessionFixture({})).rejects.toThrow(
        'createSessionFixture is strictly prohibited in production environment'
      );
    });
  });
});
