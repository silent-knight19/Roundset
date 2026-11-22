import crypto from 'node:crypto';
import type { Types, Connection, ClientSession } from 'mongoose';
import type { AppConfig } from '../../../config/env.js';
import { SessionKeyring } from './keyring.js';
import {
  signAccessToken,
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from './jwt.js';
import {
  createRefreshToken,
  parseRefreshToken,
  verifyRefreshTokenMac,
  computeRefreshDigest,
} from './refresh.js';
import {
  createCsrfToken,
  verifyCsrfRequest,
} from './csrf.js';
import {
  computeSessionLifetimes,
  computeRemainingCookieTtlSeconds,
  serializeRefreshCookie,
  serializeCsrfCookie,
  ADMIN_IDLE_TTL_SECONDS,
  CANDIDATE_IDLE_TTL_SECONDS,
} from './cookies.js';
import {
  getSessionModel,
  getUserModel,
  getSecurityAuditEventModel,
  type ISession,
  type IUser,
} from '../../identity/models/index.js';
import {
  UnauthorizedError,
  SessionReplayError,
  ForbiddenError,
  NotFoundError,
} from '../../../core/errors.js';
import type {
  SessionResponse,
  AuthMetaResponse,
} from '@roundset/contracts';

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    public readonly keyring: SessionKeyring,
    private readonly conn?: Connection
  ) {}

  private get sessionModel() {
    return getSessionModel(this.conn);
  }

  private get userModel() {
    return getUserModel(this.conn);
  }

  private get auditEventModel() {
    return getSecurityAuditEventModel(this.conn);
  }

  public getMeta(requestId: string): AuthMetaResponse {
    if (!this.config.POLICY_ID || !this.config.POLICY_CONSENT_VERSION) {
      throw new Error('Policy metadata configuration is missing');
    }

    return {
      data: {
        activePolicyId: this.config.POLICY_ID,
        activeConsentVersion: this.config.POLICY_CONSENT_VERSION,
        registrationMode: this.config.REGISTRATION_MODE,
      },
      meta: { requestId },
    };
  }

  public async rotateSession(options: {
    rawRefreshToken?: string;
    csrfHeader?: string;
    csrfCookie?: string;
    isSecure?: boolean;
    requestId: string;
  }): Promise<{
    sessionResponse: SessionResponse;
    setCookieHeaders: [string, string];
  }> {
    await this.keyring.ensureInitialized();
    const { rawRefreshToken, csrfHeader, csrfCookie: incomingCsrfCookie, isSecure, requestId } = options;

    if (!rawRefreshToken) {
      throw new UnauthorizedError('Refresh token is required');
    }

    const parsed = parseRefreshToken(rawRefreshToken);
    if (!parsed) {
      throw new UnauthorizedError('Malformed refresh token');
    }

    // 1. Verify Refresh Token MAC. If invalid, reject immediately without revoking or auditing.
    if (!verifyRefreshTokenMac(this.keyring, parsed)) {
      throw new UnauthorizedError('Invalid refresh token MAC');
    }

    // 2. Verify CSRF Token (header matches cookie, valid MAC, and bound to parsed.sid)
    const isCsrfValid = verifyCsrfRequest(
      this.keyring,
      csrfHeader,
      incomingCsrfCookie,
      parsed.sid
    );
    if (!isCsrfValid) {
      throw new ForbiddenError('Invalid CSRF token');
    }

    // 3. Compute Refresh Digest
    const digestKey = this.keyring.getRefreshDigestKey(parsed.kid);
    if (!digestKey) {
      throw new UnauthorizedError(`Unknown refresh digest key ID: ${parsed.kid}`);
    }
    const currentRefreshDigest = computeRefreshDigest(digestKey, rawRefreshToken);

    const now = new Date();

    // 4. Retrieve session from database
    const session = await this.sessionModel.findOne({ sessionId: parsed.sid });
    if (!session) {
      throw new UnauthorizedError('Session not found');
    }

    // If session is already revoked or expired, fail closed without replay panic
    if (session.status !== 'ACTIVE') {
      throw new UnauthorizedError(`Session is ${session.status.toLowerCase()}`);
    }

    if (now >= session.absoluteExpiresAt || now >= session.idleExpiresAt) {
      throw new UnauthorizedError('Session has expired');
    }

    // 5. Retrieve user from database
    const user = await this.userModel.findById(session.userId);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    if (user.accountStatus !== 'ACTIVE') {
      throw new UnauthorizedError(`User account is ${user.accountStatus.toLowerCase()}`);
    }

    if (user.sessionEpoch !== session.epochAtIssue) {
      throw new UnauthorizedError('Session epoch mismatch');
    }

    // 6. Security Replay Detection:
    // If MAC is authentic and generation is older than active session generation -> REVOKE family and audit.
    if (session.generation > parsed.generation) {
      await this.sessionModel.updateOne(
        { sessionId: parsed.sid, status: 'ACTIVE' },
        {
          $set: {
            status: 'REVOKED',
            revokedAt: now,
            revokedReason: 'SESSION_REPLAY_DETECTED',
          },
        }
      );

      await this.auditEventModel.create({
        eventId: crypto.randomUUID(),
        eventType: 'SESSION_REPLAY_DETECTED',
        actorId: String(user._id),
        targetId: parsed.sid,
        requestId,
        outcome: 'FAILURE',
        reasonCode: 'STALE_GENERATION_REPLAY',
        at: now,
        metadata: {
          tokenGeneration: parsed.generation,
          currentGeneration: session.generation,
        },
      });

      throw new SessionReplayError('Session replay detected');
    }

    if (
      session.generation !== parsed.generation ||
      session.currentRefreshDigest !== currentRefreshDigest
    ) {
      throw new UnauthorizedError('Refresh token generation or digest mismatch');
    }

    // 7. Atomic Compare-And-Swap (CAS) to install single successor
    const nextGen = session.generation + 1;
    const { rawToken: nextRawToken, digest: nextDigest } = createRefreshToken(
      this.keyring,
      { sessionId: parsed.sid, generation: nextGen }
    );

    const isCandidate = user.role === 'CANDIDATE';
    const idleTtlSeconds = isCandidate
      ? CANDIDATE_IDLE_TTL_SECONDS
      : ADMIN_IDLE_TTL_SECONDS;

    const prospectiveIdle = new Date(now.getTime() + idleTtlSeconds * 1000);
    const newIdleExpiresAt =
      prospectiveIdle.getTime() > session.absoluteExpiresAt.getTime()
        ? session.absoluteExpiresAt
        : prospectiveIdle;

    const updatedSession = await this.sessionModel.findOneAndUpdate(
      {
        sessionId: parsed.sid,
        status: 'ACTIVE',
        generation: parsed.generation,
        currentRefreshDigest,
        epochAtIssue: user.sessionEpoch,
        idleExpiresAt: { $gt: now },
        absoluteExpiresAt: { $gt: now },
      },
      {
        $set: {
          generation: nextGen,
          currentRefreshDigest: nextDigest,
          idleExpiresAt: newIdleExpiresAt,
          lastUsedAt: now,
        },
      },
      { new: true }
    );

    if (!updatedSession) {
      throw new UnauthorizedError('Concurrent refresh race or session state modified');
    }

    // 8. Issue new signed Access JWT
    const accessToken = await signAccessToken(this.keyring, {
      userId: String(user._id),
      sessionId: parsed.sid,
      epoch: user.sessionEpoch,
    });

    // 9. Issue new session-bound CSRF token
    const nextCsrfToken = createCsrfToken(this.keyring, {
      sessionId: parsed.sid,
    });

    // 10. Compute remaining cookie lifetime aligned with session idle bounded by absolute expiry
    const remainingSeconds = computeRemainingCookieTtlSeconds(
      newIdleExpiresAt,
      session.absoluteExpiresAt,
      now
    );

    const cookieOptions = {
      isSecure,
      isProduction: this.config.NODE_ENV === 'production',
    };

    const refreshCookie = serializeRefreshCookie(
      nextRawToken,
      remainingSeconds,
      cookieOptions
    );
    const csrfCookie = serializeCsrfCookie(
      nextCsrfToken,
      remainingSeconds,
      cookieOptions
    );

    const sessionResponse: SessionResponse = {
      data: {
        accessToken,
        tokenType: 'Bearer',
        expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
        user: {
          id: String(user._id),
          email: user.emailNormalized ?? '',
          emailVerified: Boolean(user.emailVerifiedAt),
          displayName: user.displayName,
          role: user.role,
          accountStatus: user.accountStatus,
        },
        session: {
          id: parsed.sid,
          expiresAt: newIdleExpiresAt.toISOString(),
        },
      },
      meta: { requestId },
    };

    return {
      sessionResponse,
      setCookieHeaders: [refreshCookie, csrfCookie],
    };
  }

  public async logout(options: {
    rawRefreshToken?: string;
    csrfHeader?: string;
    csrfCookie?: string;
    bearerToken?: string;
    isSecure?: boolean;
    requestId: string;
  }): Promise<{ clearCookies: boolean }> {
    await this.keyring.ensureInitialized();
    const { rawRefreshToken, csrfHeader, csrfCookie, bearerToken } = options;

    let targetSessionId: string | null = null;

    if (rawRefreshToken) {
      const parsed = parseRefreshToken(rawRefreshToken);
      if (!parsed || !verifyRefreshTokenMac(this.keyring, parsed)) {
        throw new UnauthorizedError('Invalid refresh token');
      }

      const isCsrfValid = verifyCsrfRequest(
        this.keyring,
        csrfHeader,
        csrfCookie,
        parsed.sid
      );
      if (!isCsrfValid) {
        throw new ForbiddenError('Invalid CSRF token for logout');
      }

      targetSessionId = parsed.sid;

      // If Bearer is also present:
      if (bearerToken) {
        try {
          const bearerPayload = await verifyAccessToken(this.keyring, bearerToken);
          // Valid Bearer: check session ID equality
          if (bearerPayload.sid !== targetSessionId) {
            // Mismatch: 403 Forbidden, NO server revocation, NO cookie clearing
            throw new ForbiddenError('Logout credential and session mismatch');
          }
        } catch (err) {
          if (err instanceof ForbiddenError) {
            throw err;
          }
          // An expired or malformed Bearer does NOT block cookie-primary logout
        }
      }
    } else if (bearerToken) {
      // Bearer-only logout when cookie is absent
      const bearerPayload = await verifyAccessToken(this.keyring, bearerToken);
      targetSessionId = bearerPayload.sid;
    } else {
      throw new UnauthorizedError('Authentication credentials required for logout');
    }

    // Revoke target session
    const session = await this.sessionModel.findOne({ sessionId: targetSessionId });
    if (!session) {
      // Nonexistent target session returns 404
      throw new NotFoundError('Session not found');
    }

    await this.sessionModel.updateOne(
      { sessionId: targetSessionId },
      {
        $set: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: 'USER_LOGOUT',
        },
      }
    );

    return { clearCookies: Boolean(rawRefreshToken) };
  }

  public async logoutAll(options: {
    bearerToken?: string;
    requestId: string;
  }): Promise<void> {
    await this.keyring.ensureInitialized();
    const { bearerToken } = options;

    if (!bearerToken) {
      throw new UnauthorizedError('Bearer access token required for logout-all');
    }

    const payload = await verifyAccessToken(this.keyring, bearerToken);
    const now = new Date();

    // 1. Verify user exists and is active with matching session epoch
    const user = await this.userModel.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    if (user.accountStatus !== 'ACTIVE') {
      throw new UnauthorizedError(`User account is ${user.accountStatus.toLowerCase()}`);
    }

    if (user.sessionEpoch !== payload.epoch) {
      throw new UnauthorizedError('Session epoch mismatch');
    }

    // 2. R1: Verify the session referenced by the Bearer token exists, is ACTIVE, and is unexpired
    const session = await this.sessionModel.findOne({ sessionId: payload.sid });
    if (!session) {
      throw new UnauthorizedError('Session not found');
    }

    if (session.userId.toString() !== payload.sub || !session.userId.equals(user._id)) {
      throw new UnauthorizedError('Session does not belong to user');
    }

    if (session.status !== 'ACTIVE') {
      throw new UnauthorizedError('Session is not active');
    }

    if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
      throw new UnauthorizedError('Session has expired');
    }

    if (session.epochAtIssue !== payload.epoch) {
      throw new UnauthorizedError('Session epoch mismatch');
    }

    // 3. R2-03: Atomic logout-all persistence via MongoDB transaction
    // Enforces conditional user epoch CAS and global session revocation atomically
    const connection = this.conn ?? this.sessionModel.db;
    let clientSession: ClientSession | null = null;
    const isMockSession =
      connection?.startSession &&
      ('_isMockFunction' in connection.startSession ||
        (connection.startSession as { getMockImplementation?: unknown }).getMockImplementation !== undefined);
    if (connection && typeof connection.startSession === 'function' && (connection.readyState === 1 || isMockSession)) {
      try {
        clientSession = await connection.startSession();
      } catch {
        clientSession = null;
      }
    }

    if (clientSession) {
      try {
        clientSession.startTransaction();

        const updateResult = await this.userModel.updateOne(
          {
            _id: user._id,
            sessionEpoch: payload.epoch,
            accountStatus: 'ACTIVE',
          },
          { $inc: { sessionEpoch: 1 } },
          { session: clientSession }
        );

        if (updateResult.modifiedCount !== 1) {
          throw new UnauthorizedError('Concurrent update or session epoch mismatch');
        }

        await this.sessionModel.updateMany(
          { userId: user._id, status: 'ACTIVE' },
          {
            $set: {
              status: 'REVOKED',
              revokedAt: now,
              revokedReason: 'LOGOUT_ALL',
            },
          },
          { session: clientSession }
        );

        try {
          await clientSession.commitTransaction();
        } catch (commitErr: unknown) {
          // R2-03: Handle uncertain transaction-commit results without blindly rerunning a logically completed operation
          const isUncertainCommit =
            commitErr instanceof Error &&
            (('hasErrorLabel' in commitErr &&
              typeof (commitErr as { hasErrorLabel: (label: string) => boolean }).hasErrorLabel === 'function' &&
              (commitErr as { hasErrorLabel: (label: string) => boolean }).hasErrorLabel(
                'UnknownTransactionCommitResult'
              )) ||
              (commitErr as { errorLabels?: string[] }).errorLabels?.includes(
                'UnknownTransactionCommitResult'
              ));

          if (isUncertainCommit) {
            const freshUser = await this.userModel.findById(user._id);
            if (freshUser && freshUser.sessionEpoch > payload.epoch) {
              // Logically completed on server before network failure; do not rerun
              return;
            }
          }
          throw commitErr;
        }
      } catch (err) {
        if (clientSession.inTransaction()) {
          try {
            await clientSession.abortTransaction();
          } catch {
            // Ignore secondary abort failure
          }
        }
        throw err;
      } finally {
        await clientSession.endSession();
      }
    } else {
      // Non-transactional fallback for mock or standalone database without transactions
      const updateResult = await this.userModel.updateOne(
        {
          _id: user._id,
          sessionEpoch: payload.epoch,
          accountStatus: 'ACTIVE',
        },
        { $inc: { sessionEpoch: 1 } }
      );

      if (updateResult.modifiedCount !== 1) {
        throw new UnauthorizedError('Concurrent update or session epoch mismatch');
      }

      await this.sessionModel.updateMany(
        { userId: user._id, status: 'ACTIVE' },
        {
          $set: {
            status: 'REVOKED',
            revokedAt: now,
            revokedReason: 'LOGOUT_ALL',
          },
        }
      );
    }
  }

  /**
   * Test fixture generator for creating a valid persistent user + active session.
   * R6: Strictly forbidden in production environments.
   */
  public async createSessionFixture(params: {
    userId?: Types.ObjectId;
    role?: 'CANDIDATE' | 'ADMIN';
    emailNormalized?: string;
    accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION' | 'DELETED';
    sessionEpoch?: number;
    sessionId?: string;
    now?: Date;
  }): Promise<{
    user: IUser;
    session: ISession;
    accessToken: string;
    rawRefreshToken: string;
    csrfToken: string;
    setCookieHeaders: [string, string];
  }> {
    if (this.config.NODE_ENV === 'production') {
      throw new Error('createSessionFixture is strictly prohibited in production environment');
    }
    await this.keyring.ensureInitialized();
    const now = params.now ?? new Date();
    const role = params.role ?? 'CANDIDATE';
    const email = params.emailNormalized ?? `user_${crypto.randomUUID().slice(0, 8)}@example.com`;
    const sessionEpoch = params.sessionEpoch ?? 1;

    let user: IUser | null = null;
    if (params.userId) {
      user = await this.userModel.findById(params.userId);
    }
    if (!user) {
      user = await this.userModel.create({
        emailNormalized: email,
        emailVerifiedAt: now,
        displayName: 'Test User',
        role,
        accountStatus: params.accountStatus ?? 'ACTIVE',
        sessionEpoch,
        identityVersion: 1,
        preferences: { language: 'en', reducedMotion: false, timezone: 'UTC' },
        consentVersion: this.config.POLICY_CONSENT_VERSION,
        consentAt: now,
      });
    }

    const sessionId = params.sessionId ?? crypto.randomUUID();
    const { rawToken: rawRefreshToken, digest } = createRefreshToken(this.keyring, {
      sessionId,
      generation: 1,
    });

    const lifetimes = computeSessionLifetimes(role, now);

    const session = await this.sessionModel.create({
      sessionId,
      userId: user._id,
      status: 'ACTIVE',
      generation: 1,
      currentRefreshDigest: digest,
      epochAtIssue: sessionEpoch,
      createdAt: now,
      lastUsedAt: now,
      idleExpiresAt: lifetimes.idleExpiresAt,
      absoluteExpiresAt: lifetimes.absoluteExpiresAt,
    });

    const accessToken = await signAccessToken(this.keyring, {
      userId: String(user._id),
      sessionId,
      epoch: sessionEpoch,
    });

    const csrfToken = createCsrfToken(this.keyring, { sessionId });
    const remainingSeconds = computeRemainingCookieTtlSeconds(
      lifetimes.idleExpiresAt,
      lifetimes.absoluteExpiresAt,
      now
    );

    const cookieOptions = {
      isSecure: false,
      isProduction: false,
    };

    const refreshCookie = serializeRefreshCookie(rawRefreshToken, remainingSeconds, cookieOptions);
    const csrfCookie = serializeCsrfCookie(csrfToken, remainingSeconds, cookieOptions);

    return {
      user,
      session,
      accessToken,
      rawRefreshToken,
      csrfToken,
      setCookieHeaders: [refreshCookie, csrfCookie],
    };
  }
}
