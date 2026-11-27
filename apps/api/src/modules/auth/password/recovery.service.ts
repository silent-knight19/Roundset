import type { Connection } from 'mongoose';
import type { PasswordForgotRequest, PasswordResetRequest } from '@roundset/contracts';
import { HttpError, ServiceUnavailableError } from '../../../core/errors.js';
import {
  getAuthIdentityModel, getSessionModel, getUserModel, getVerificationChallengeModel,
} from '../../identity/models/index.js';
import type { EmailSender } from '../email/types.js';
import { computeDomainHmac } from '../otp/crypto.js';
import type { OtpChallengeService } from '../otp/otp.service.js';
import { OtpInvalidError, type ChallengeSubjectInput } from '../otp/types.js';
import type { AuthRateLimitService } from '../rate-limit/rate-limit.service.js';
import { runAuthTransaction } from '../transaction.js';
import type { PasswordService } from './password.service.js';

export interface PasswordRecoveryOptions {
  connection: Connection;
  passwords: PasswordService;
  otp: OtpChallengeService;
  rateLimits: AuthRateLimitService;
  emailSender: EmailSender;
  hmacSecret: string;
  /** Global provider availability, checked before subject lookup. */
  emailAvailable: () => boolean | Promise<boolean>;
}

type RecoveryBinding = Extract<ChallengeSubjectInput, { purpose: 'RESET_PASSWORD' }>;

export class PasswordRecoveryService {
  constructor(private readonly options: PasswordRecoveryOptions) {}

  private assertDatabaseReady(): void {
    if (this.options.connection.readyState !== 1) {
      throw new ServiceUnavailableError('Authentication database unavailable');
    }
  }

  async forgot(input: PasswordForgotRequest, trustedIp: string): Promise<void> {
    const { connection, rateLimits, otp, emailSender, emailAvailable } = this.options;
    this.assertDatabaseReady();
    let available = false;
    try { available = await emailAvailable(); } catch { available = false; }
    if (!available) throw new HttpError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Email verification is unavailable');

    await rateLimits.consumeOrThrow('PASSWORD_FORGOT_IP', trustedIp);
    await rateLimits.consumeOrThrow('PASSWORD_FORGOT_EMAIL', input.email);

    // The public response is identical for absent, inactive, Google-only and
    // eligible accounts. Never issue a challenge against an unverified address.
    try {
      const user = await getUserModel(connection).findOne({
        emailNormalized: input.email, accountStatus: 'ACTIVE',
      }).exec();
      if (!user?.emailVerifiedAt) return;
      const identity = await getAuthIdentityModel(connection).findOne({
        userId: user._id, provider: 'PASSWORD', subject: input.email,
      }).exec();
      if (!identity?.passwordHash) return;
      const binding: RecoveryBinding = {
        purpose: 'RESET_PASSWORD', emailNormalized: input.email,
        userId: user._id, passwordIdentityIdAtIssue: identity._id,
        identityVersionAtIssue: user.identityVersion,
      };
      const issued = await otp.issueChallenge(binding);
      let accepted = false;
      try {
        const result = await emailSender.sendOtpEmail({
          purpose: 'RESET_PASSWORD', toEmail: input.email, otpCode: issued.otpCode,
          correlationId: issued.challengeId, generation: issued.generation,
        });
        accepted = result.accepted;
      } catch {
        // Provider failure is recipient-independent at the HTTP boundary.
      }
      // A failed or superseded delivery never authorizes OTP consumption.
      await otp.markDeliveryState(issued.challengeId, issued.generation, accepted ? 'ACCEPTED' : 'FAILED');
    } catch {
      // Post-admission lookup, issuance and recording failures must not
      // become an account oracle. An unconfirmed challenge fails closed.
    }
  }

  async reset(input: PasswordResetRequest, trustedIp: string): Promise<void> {
    const { connection, rateLimits, otp, passwords, hmacSecret } = this.options;
    this.assertDatabaseReady();
    await rateLimits.consumeOrThrow('PASSWORD_RESET_IP', trustedIp);
    await rateLimits.consumeOrThrow('PASSWORD_RESET_EMAIL', input.email);
    const users = getUserModel(connection);
    const identities = getAuthIdentityModel(connection);
    const sessions = getSessionModel(connection);
    const challenge = await getVerificationChallengeModel(connection).findOne({
      purpose: 'RESET_PASSWORD',
      subjectDigest: computeDomainHmac(hmacSecret, ['RESET_PASSWORD', input.email]),
      state: 'ISSUED', deliveryState: 'ACCEPTED', expiresAt: { $gt: new Date() },
    }).exec();
    if (!challenge?.userId || !challenge.passwordIdentityIdAtIssue ||
        typeof challenge.identityVersionAtIssue !== 'number') throw new OtpInvalidError();

    // Capture the persisted immutable principal/credential binding. Never
    // substitute the current owner of an email address for the issued owner.
    const binding: RecoveryBinding = {
      purpose: 'RESET_PASSWORD', emailNormalized: input.email,
      userId: challenge.userId, passwordIdentityIdAtIssue: challenge.passwordIdentityIdAtIssue,
      identityVersionAtIssue: challenge.identityVersionAtIssue,
    };
    const authority = {
      userModel: users, authIdentityModel: identities, userId: binding.userId,
      passwordIdentityIdAtIssue: binding.passwordIdentityIdAtIssue,
      identityVersionAtIssue: binding.identityVersionAtIssue, emailNormalized: input.email,
    };

    await otp.verifyAuthoritativeRecoveryBinding(authority);
    const proof = await otp.claimAndVerifyAttempt(binding, challenge.challengeId, challenge.generation, input.code);
    const passwordHash = await passwords.hashPassword(input.newPassword);

    try {
      await runAuthTransaction(connection, async session => {
        await otp.verifyAuthoritativeRecoveryBinding({ ...authority, session });
        const user = await users.updateOne({
          _id: binding.userId, accountStatus: 'ACTIVE', emailNormalized: input.email,
          identityVersion: binding.identityVersionAtIssue,
          emailVerifiedAt: { $type: 'date' as const },
        }, { $inc: { identityVersion: 1, sessionEpoch: 1 } }, { session }).exec();
        if (user.modifiedCount !== 1) throw new OtpInvalidError();

        const identity = await identities.updateOne({
          _id: binding.passwordIdentityIdAtIssue, userId: binding.userId,
          provider: 'PASSWORD', subject: input.email,
        }, { $set: { passwordHash } }, { session }).exec();
        if (identity.matchedCount !== 1) throw new OtpInvalidError();

        await otp.consumeVerifiedChallenge(proof, session);
        await sessions.updateMany({
          userId: binding.userId, status: 'ACTIVE',
        }, {
          $set: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' },
          $unset: { currentRefreshDigest: 1 },
        }, { session }).exec();
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === 'STATE_CONFLICT') throw new OtpInvalidError();
      throw error;
    }
  }
}
