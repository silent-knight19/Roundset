import mongoose, { Connection, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getAuthIdentityModel,
  getAuthRateLimitModel,
  getPendingRegistrationModel,
  getUserModel,
  getVerificationChallengeModel,
  syncIdentityIndexes,
} from '../src/modules/identity/models/index.js';
import {
  OtpChallengeService,
  OtpInvalidError,
  compareDigestConstantTime,
} from '../src/modules/auth/otp/index.js';
import { AuthRateLimitService, RateLimitExceededError } from '../src/modules/auth/rate-limit/index.js';
import { PendingRegistrationService } from '../src/modules/auth/registration/index.js';
import { MockEmailSender } from '../src/modules/auth/email/index.js';
import { createPasswordService } from '../src/modules/auth/password/index.js';
import { validateIntegrationDatabaseName } from './identity-test-harness.js';

const RUN_LIVE = process.env.RUN_LIVE_MONGODB_TESTS === 'true';
const MONGODB_TEST_URI = process.env.MONGODB_TEST_URI ?? '';
const TEST_HMAC_SECRET = 'live-mongo-test-hmac-secret-at-least-32-chars';

describe.skipIf(!RUN_LIVE)(
  'P2-AUTH-04a Live MongoDB Replica-Set Integration Tests',
  () => {
    let conn: Connection;

    beforeAll(async () => {
      validateIntegrationDatabaseName(MONGODB_TEST_URI);
      conn = await mongoose.createConnection(MONGODB_TEST_URI).asPromise();
      await syncIdentityIndexes(conn);
    });

    afterAll(async () => {
      if (conn) {
        await conn.close();
      }
    });

    it('enforces max 5 digest comparisons across 20 concurrent OTP attempts in MongoDB', async () => {
      const ChallengeModel = getVerificationChallengeModel(conn);
      const compareSpy = vi.fn(compareDigestConstantTime);
      const otpService = new OtpChallengeService({
        challengeModel: ChallengeModel,
        hmacSecret: TEST_HMAC_SECRET,
        compareDigest: compareSpy,
      });

      const subject = {
        purpose: 'PHONE_VERIFY' as const,
        phoneE164: '+14155552671',
        userId: new Types.ObjectId(),
      };

      const issued = await otpService.issueChallenge(subject);
      await otpService.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED');

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          otpService.claimAndVerifyAttempt(subject, issued.challengeId, issued.generation, '000000')
        )
      );

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(compareSpy).toHaveBeenCalledTimes(5);
      await ChallengeModel.deleteOne({ challengeId: issued.challengeId });
    });

    it('enforces parallel correct-code consumption with only 1 committed winner and rollback on abort', async () => {
      const ChallengeModel = getVerificationChallengeModel(conn);
      const otpService = new OtpChallengeService({
        challengeModel: ChallengeModel,
        hmacSecret: TEST_HMAC_SECRET,
      });

      const subject = {
        purpose: 'RESET_PASSWORD' as const,
        emailNormalized: `live_consume_${Date.now()}@example.com`,
        userId: new Types.ObjectId(),
        passwordIdentityIdAtIssue: new Types.ObjectId(),
        identityVersionAtIssue: 1,
      };

      const issued = await otpService.issueChallenge(subject);
      await otpService.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED');

      const proof = await otpService.claimAndVerifyAttempt(
        subject,
        issued.challengeId,
        issued.generation,
        issued.otpCode
      );

      // 1. Rollback leaves challenge ISSUED
      const sAbort = await conn.startSession();
      sAbort.startTransaction();
      await otpService.consumeVerifiedChallenge(proof, sAbort);
      await sAbort.abortTransaction();
      await sAbort.endSession();

      // Re-verify after rollback
      const proof2 = await otpService.claimAndVerifyAttempt(
        subject,
        issued.challengeId,
        issued.generation,
        issued.otpCode
      );

      // 2. Parallel consumption: only 1 winner
      const s1 = await conn.startSession();
      const s2 = await conn.startSession();
      s1.startTransaction();
      s2.startTransaction();

      const outcomes = await Promise.allSettled([
        otpService.consumeVerifiedChallenge(proof2, s1).then(() => s1.commitTransaction()),
        otpService.consumeVerifiedChallenge(proof2, s2).then(() => s2.commitTransaction()),
      ]);
      await s1.endSession();
      await s2.endSession();

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      await ChallengeModel.deleteOne({ challengeId: issued.challengeId });
    });

    it('supports pending-registration replacement and resend in MongoDB', async () => {
      const PendingModel = getPendingRegistrationModel(conn);
      const RateLimitModel = getAuthRateLimitModel(conn);
      const emailSender = new MockEmailSender({ nodeEnv: 'test', enableTestOtpCapture: true });
      let currentTime = new Date();

      const regService = new PendingRegistrationService({
        pendingRegistrationModel: PendingModel,
        rateLimitService: new AuthRateLimitService({
          rateLimitModel: RateLimitModel,
          hmacSecret: TEST_HMAC_SECRET,
          now: () => currentTime,
        }),
        passwordService: createPasswordService(),
        emailSender,
        hmacSecret: TEST_HMAC_SECRET,
        now: () => currentTime,
      });

      const email = `live_reg_${Date.now()}@example.com`;
      const r1 = await regService.startOrReplaceRegistration({
        emailNormalized: email,
        password: 'Valid-Password-2026!',
        consentVersion: 'v1.0',
        trustedIp: '203.0.113.50',
      });

      currentTime = new Date(currentTime.getTime() + 61_000);
      const resend = await regService.resendRegistrationOtp({
        registrationId: r1.registrationId,
        nonce: r1.nonce,
        trustedIp: '203.0.113.50',
      });
      expect(resend.version).toBe(2);

      await PendingModel.deleteOne({ emailNormalized: email });
    });

    it('verifies authoritative recovery binding against current User and AuthIdentity', async () => {
      const ChallengeModel = getVerificationChallengeModel(conn);
      const UserModel = getUserModel(conn);
      const AuthIdentityModel = getAuthIdentityModel(conn);
      const otpService = new OtpChallengeService({
        challengeModel: ChallengeModel,
        hmacSecret: TEST_HMAC_SECRET,
      });

      const email = `live_rec_${Date.now()}@example.com`;
      const user = await UserModel.create({
        emailNormalized: email,
        emailVerifiedAt: new Date(),
        displayName: 'Test User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: 'v1.0',
        consentAt: new Date(),
      });
      const pwIdentity = await AuthIdentityModel.create({
        userId: user._id,
        provider: 'PASSWORD',
        subject: email,
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });

      await expect(
        otpService.verifyAuthoritativeRecoveryBinding({
          userModel: UserModel,
          authIdentityModel: AuthIdentityModel,
          userId: user._id,
          passwordIdentityIdAtIssue: pwIdentity._id,
          identityVersionAtIssue: 1,
          emailNormalized: email,
        })
      ).resolves.toBeUndefined();

      // Version mismatch rejected
      await expect(
        otpService.verifyAuthoritativeRecoveryBinding({
          userModel: UserModel,
          authIdentityModel: AuthIdentityModel,
          userId: user._id,
          passwordIdentityIdAtIssue: pwIdentity._id,
          identityVersionAtIssue: 2,
          emailNormalized: email,
        })
      ).rejects.toThrow(OtpInvalidError);

      await AuthIdentityModel.deleteOne({ _id: pwIdentity._id });
      await UserModel.deleteOne({ _id: user._id });
    });

    it('enforces concurrent persistent rate-limit admission in MongoDB', async () => {
      const RateLimitModel = getAuthRateLimitModel(conn);
      const rateService = new AuthRateLimitService({
        rateLimitModel: RateLimitModel,
        hmacSecret: TEST_HMAC_SECRET,
      });

      const key = `live_rate_${Date.now()}@example.com`;
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => rateService.consumeOrThrow('PASSWORD_FORGOT_EMAIL', key))
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(
        results.filter(
          (r) => r.status === 'rejected' && r.reason instanceof RateLimitExceededError
        )
      ).toHaveLength(2);

      await RateLimitModel.deleteOne({
        bucketKey: rateService.computeBucketKey('PASSWORD_FORGOT_EMAIL', key),
      });
    });
  }
);
