import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import type { LoginRequest, SessionResponse } from '@roundset/contracts';
import type { AppConfig } from '../../../config/env.js';
import { HttpError, ServiceUnavailableError } from '../../../core/errors.js';
import { getAuthIdentityModel, getSessionModel, getUserModel } from '../../identity/models/index.js';
import { runAuthTransaction } from '../transaction.js';
import type { AuthRateLimitService } from '../rate-limit/rate-limit.service.js';
import type { SessionKeyring } from '../session/keyring.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../session/jwt.js';
import { createRefreshToken } from '../session/refresh.js';
import { createCsrfToken } from '../session/csrf.js';
import {
  computeSessionLifetimes,
  computeRemainingCookieTtlSeconds,
  serializeRefreshCookie,
  serializeCsrfCookie,
} from '../session/cookies.js';
import type { PasswordService } from './password.service.js';
import { PasswordHashPolicyError } from './types.js';

export interface PasswordLoginOptions {
  connection: Connection;
  config: Pick<AppConfig, 'NODE_ENV'>;
  keyring: SessionKeyring;
  passwords: PasswordService;
  rateLimits: AuthRateLimitService;
}

export interface PasswordLoginResult {
  sessionResponse: SessionResponse;
  setCookieHeaders: [string, string];
}

function invalidCredentials(): HttpError {
  return new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
}

/**
 * Password comparison is outside the transaction and uses the shared bounded
 * Argon2 service. Issuance then serializes against credential/account changes
 * using a guarded actual write on the authoritative user and credential.
 */
export class PasswordLoginService {
  constructor(private readonly options: PasswordLoginOptions) {}

  async login(
    input: LoginRequest,
    trustedIp: string,
    requestId: string,
    isSecure: boolean
  ): Promise<PasswordLoginResult> {
    const { connection, keyring, passwords, rateLimits, config } = this.options;
    if (connection.readyState !== 1) {
      throw new ServiceUnavailableError('Authentication database unavailable');
    }

    await rateLimits.consumeOrThrow('LOGIN_IP', trustedIp);
    const reservation = await rateLimits.reserveLoginAttempt(input.email);
    const users = getUserModel(connection);
    const identities = getAuthIdentityModel(connection);
    const sessions = getSessionModel(connection);
    const user = await users.findOne({ emailNormalized: input.email }).exec();
    const identity = user ? await identities.findOne({
      userId: user._id, provider: 'PASSWORD', subject: input.email,
    }).exec() : null;

    if (!user || !identity?.passwordHash) {
      await passwords.verifyDummy(input.password);
      throw invalidCredentials();
    }

    const passwordHash = identity.passwordHash;
    let valid = false;
    try {
      valid = await passwords.verifyPassword(input.password, passwordHash);
    } catch (error) {
      if (!(error instanceof PasswordHashPolicyError)) throw error;
      // A malformed stored credential must not become an account oracle.
      await passwords.verifyDummy(input.password);
      throw invalidCredentials();
    }
    if (!valid) throw invalidCredentials();

    await rateLimits.releaseProvenLoginAttempt(reservation);
    if (user.accountStatus === 'SUSPENDED') {
      throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
    }
    if (user.accountStatus !== 'ACTIVE') throw invalidCredentials();
    if (!user.emailVerifiedAt) {
      throw new HttpError(403, 'EMAIL_UNVERIFIED', 'Email verification is required');
    }

    // Snapshot the exact credential and authority proved outside MongoDB.
    const userId = user._id;
    const identityId = identity._id;
    const expectedEpoch = user.sessionEpoch;
    const expectedVersion = user.identityVersion;

    await keyring.ensureInitialized();
    const sessionId = randomUUID();
    const { rawToken, digest } = createRefreshToken(keyring, { sessionId, generation: 1 });
    const csrf = createCsrfToken(keyring, { sessionId });
    const accessToken = await signAccessToken(keyring, {
      userId: String(userId), sessionId, epoch: expectedEpoch,
    });

    const committed = await runAuthTransaction(connection, async (session) => {
      const authority = {
        _id: userId,
        emailNormalized: input.email,
        accountStatus: 'ACTIVE' as const,
        sessionEpoch: expectedEpoch,
        identityVersion: expectedVersion,
        emailVerifiedAt: { $type: 'date' as const },
      };
      const current = await users.findOne(authority, null, { session }).exec();
      if (!current) throw invalidCredentials();

      const now = new Date();
      // Force a real shared-document write even for simultaneous logins
      // in the same millisecond. Do not bump epoch/version on ordinary login.
      const fenceAt = new Date(Math.max(now.getTime(), (current.updatedAt?.getTime() ?? 0) + 1));
      const fenced = await users.findOneAndUpdate(
        authority, { $set: { updatedAt: fenceAt } },
        { session, new: true, timestamps: false }
      ).exec();
      if (!fenced) throw invalidCredentials();

      const credential = await identities.updateOne({
        _id: identityId,
        userId,
        provider: 'PASSWORD',
        subject: input.email,
        passwordHash,
      }, { $set: { lastUsedAt: now } }, { session }).exec();
      if (credential.matchedCount !== 1) throw invalidCredentials();

      const lifetimes = computeSessionLifetimes(fenced.role, now);
      await sessions.create([{
        sessionId,
        userId,
        status: 'ACTIVE',
        generation: 1,
        currentRefreshDigest: digest,
        epochAtIssue: expectedEpoch,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: lifetimes.idleExpiresAt,
        absoluteExpiresAt: lifetimes.absoluteExpiresAt,
      }], { session });

      return {
        user: {
          id: String(userId),
          email: input.email,
          emailVerified: true,
          displayName: fenced.displayName,
          role: fenced.role,
          accountStatus: fenced.accountStatus,
        },
        lifetimes,
      };
    });

    // No cookie or bearer is returned before durable session commit.
    const cookieOptions = { isProduction: config.NODE_ENV === 'production', isSecure };
    const ttl = computeRemainingCookieTtlSeconds(
      committed.lifetimes.idleExpiresAt, committed.lifetimes.absoluteExpiresAt
    );
    return {
      sessionResponse: {
        data: {
          accessToken,
          tokenType: 'Bearer',
          expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
          user: committed.user,
          session: { id: sessionId, expiresAt: committed.lifetimes.idleExpiresAt.toISOString() },
        },
        meta: { requestId },
      },
      setCookieHeaders: [
        serializeRefreshCookie(rawToken, ttl, cookieOptions),
        serializeCsrfCookie(csrf, ttl, cookieOptions),
      ],
    };
  }
}
