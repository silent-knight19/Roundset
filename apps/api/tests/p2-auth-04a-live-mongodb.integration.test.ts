import mongoose, { Connection, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getAuthRateLimitModel,
  getPendingRegistrationModel,
  getVerificationChallengeModel,
  syncIdentityIndexes,
} from '../src/modules/identity/models/index.js';
import { OtpChallengeService, OtpInvalidError } from '../src/modules/auth/otp/index.js';
import { AuthRateLimitService, RateLimitExceededError } from '../src/modules/auth/rate-limit/index.js';
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

    it('enforces atomic attempt claim (max 5) and transactional consumption with rollback on abort', async () => {
      const ChallengeModel = getVerificationChallengeModel(conn);
      const otpService = new OtpChallengeService({
        challengeModel: ChallengeModel,
        hmacSecret: TEST_HMAC_SECRET,
      });

      const subject = {
        purpose: 'RESET_PASSWORD' as const,
        emailNormalized: `live_${Date.now()}@example.com`,
        userId: new Types.ObjectId(),
        passwordIdentityIdAtIssue: new Types.ObjectId(),
        identityVersionAtIssue: 1,
      };

      const issued = await otpService.issueChallenge(subject);
      await otpService.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED');

      const session = await conn.startSession();
      session.startTransaction();
      await otpService.consumeVerifiedChallenge(
        subject,
        issued.challengeId,
        issued.generation,
        session
      );
      await session.abortTransaction();
      await session.endSession();

      // After rollback, challenge is still ISSUED and verifiable
      await expect(
        otpService.claimAndVerifyAttempt(subject, issued.challengeId, issued.generation, issued.otpCode)
      ).resolves.toMatchObject({ challengeId: issued.challengeId });

      await ChallengeModel.deleteOne({ challengeId: issued.challengeId });
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

    it('verifies PendingRegistrationModel unique email index exists', async () => {
      const PendingModel = getPendingRegistrationModel(conn);
      const indexes = await PendingModel.collection.indexes();
      expect(indexes.some((idx) => idx.key?.emailNormalized === 1 && idx.unique === true)).toBe(
        true
      );
      expect(OtpInvalidError).toBeDefined();
    });
  }
);
