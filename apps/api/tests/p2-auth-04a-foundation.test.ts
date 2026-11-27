import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request } from 'express';
import {
  MockEmailSender,
  type EmailSender,
} from '../src/modules/auth/email/index.js';
import {
  OtpChallengeService,
  OtpInvalidError,
  compareDigestConstantTime,
  computeOtpDigest,
  computeSubjectDigest,
  generateOtpCode,
  type ChallengeSubjectInput,
  type VerifiedOtpChallengeProof,
} from '../src/modules/auth/otp/index.js';
import {
  AuthRateLimitService,
  InProcessFloodShedder,
  RateLimitExceededError,
  createFloodShedderMiddleware,
  extractTrustedClientIp,
} from '../src/modules/auth/rate-limit/index.js';
import {
  PendingRegistrationService,
  parseRegistrationCookie,
  serializeClearRegistrationCookie,
  serializeRegistrationCookie,
} from '../src/modules/auth/registration/index.js';
import { createPasswordService } from '../src/modules/auth/password/index.js';
import { ForbiddenError } from '../src/core/errors.js';

const TEST_HMAC_SECRET = 'test-hmac-secret-at-least-32-chars-long-0123456789';

/**
 * In-memory atomic store simulating Mongoose findOneAndUpdate/findOne/create
 * for deterministic unit & concurrency tests (not a substitute for live Mongo).
 */
function createInMemoryRateLimitModel() {
  const docs = new Map<
    string,
    { bucketKey: string; count: number; windowEnd: Date; expiresAt: Date }
  >();

  return {
    docs,
    findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>) {
      return {
        async exec() {
          const bucketKey = filter.bucketKey as string;
          const doc = docs.get(bucketKey);
          if (!doc) return null;

          const windowEndFilter = filter.windowEnd as
            | { $gt?: Date; $lte?: Date }
            | undefined;
          if (windowEndFilter?.$gt && !(doc.windowEnd > windowEndFilter.$gt)) {
            return null;
          }
          if (windowEndFilter?.$lte && !(doc.windowEnd <= windowEndFilter.$lte)) {
            return null;
          }

          const countFilter = filter.count as { $lt?: number } | undefined;
          if (countFilter?.$lt !== undefined && !(doc.count < countFilter.$lt)) {
            return null;
          }

          const inc = update.$inc as { count?: number } | undefined;
          if (inc?.count) {
            doc.count += inc.count;
          }
          const set = update.$set as
            | { count?: number; windowEnd?: Date; expiresAt?: Date }
            | undefined;
          if (set) {
            if (set.count !== undefined) doc.count = set.count;
            if (set.windowEnd !== undefined) doc.windowEnd = set.windowEnd;
            if (set.expiresAt !== undefined) doc.expiresAt = set.expiresAt;
          }
          return { ...doc };
        },
      };
    },
    findOne(filter: Record<string, unknown>) {
      return {
        async exec() {
          const bucketKey = filter.bucketKey as string;
          const doc = docs.get(bucketKey);
          if (!doc) return null;
          const windowEndFilter = filter.windowEnd as { $gt?: Date } | undefined;
          if (windowEndFilter?.$gt && !(doc.windowEnd > windowEndFilter.$gt)) {
            return null;
          }
          return { ...doc };
        },
      };
    },
    async create(data: {
      bucketKey: string;
      count: number;
      windowEnd: Date;
      expiresAt: Date;
    }) {
      if (docs.has(data.bucketKey)) {
        const err = new Error('Duplicate key') as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      const copy = { ...data };
      docs.set(data.bucketKey, copy);
      return copy;
    },
  };
}

function createInMemoryChallengeModel() {
  const docs = new Map<string, Record<string, unknown>>();
  let idSeq = 0;

  function matchesFilter(
    doc: Record<string, unknown>,
    filter: Record<string, unknown>
  ): boolean {
    for (const [key, val] of Object.entries(filter)) {
      if (key === 'expiresAt' && typeof val === 'object' && val !== null) {
        const gt = (val as { $gt?: Date }).$gt;
        if (gt && !((doc.expiresAt as Date) > gt)) return false;
      } else if (key === 'attempts' && typeof val === 'object' && val !== null) {
        const lt = (val as { $lt?: number }).$lt;
        if (lt !== undefined && !((doc.attempts as number) < lt)) return false;
      } else if (val instanceof Types.ObjectId) {
        if (!(doc[key] instanceof Types.ObjectId) || !(doc[key] as Types.ObjectId).equals(val)) {
          return false;
        }
      } else if (doc[key] !== val) {
        return false;
      }
    }
    return true;
  }

  return {
    docs,
    findOne(filter: Record<string, unknown>) {
      return {
        async exec() {
          for (const doc of docs.values()) {
            if (matchesFilter(doc, filter)) {
              return { ...doc };
            }
          }
          return null;
        },
      };
    },
    async create(data: Record<string, unknown>) {
      const key = `${data.purpose}:${data.subjectDigest}`;
      if (docs.has(key)) {
        const err = new Error('Duplicate key') as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      idSeq += 1;
      const copy = { _id: `mem_${idSeq}`, ...data };
      docs.set(key, copy);
      return copy;
    },
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>
    ) {
      return {
        async exec() {
          for (const doc of docs.values()) {
            if (!matchesFilter(doc, filter)) continue;
            const set = update.$set as Record<string, unknown> | undefined;
            if (set) Object.assign(doc, set);
            const unset = update.$unset as Record<string, unknown> | undefined;
            if (unset) {
              for (const k of Object.keys(unset)) delete doc[k];
            }
            const inc = update.$inc as Record<string, number> | undefined;
            if (inc) {
              for (const [k, v] of Object.entries(inc)) {
                doc[k] = ((doc[k] as number) ?? 0) + v;
              }
            }
            return { ...doc };
          }
          return null;
        },
      };
    },
  };
}

function createInMemoryPendingRegistrationModel() {
  const byEmail = new Map<string, Record<string, unknown>>();
  let idSeq = 0;

  function matchesFilter(
    doc: Record<string, unknown>,
    filter: Record<string, unknown>
  ): boolean {
    for (const [key, val] of Object.entries(filter)) {
      if (
        (key === 'expiresAt' || key === 'otpExpiresAt') &&
        typeof val === 'object' &&
        val !== null
      ) {
        const gt = (val as { $gt?: Date }).$gt;
        if (gt && !((doc[key] as Date) > gt)) return false;
      } else if (key === 'attempts' && typeof val === 'object' && val !== null) {
        const lt = (val as { $lt?: number }).$lt;
        if (lt !== undefined && !((doc.attempts as number) < lt)) return false;
      } else if (
        typeof val === 'object' &&
        val !== null &&
        '$in' in val &&
        Array.isArray((val as { $in?: unknown[] }).$in)
      ) {
        if (!(val as { $in: unknown[] }).$in.includes(doc[key])) return false;
      } else if (doc[key] !== val) {
        return false;
      }
    }
    return true;
  }

  return {
    byEmail,
    findOne(filter: Record<string, unknown>) {
      return {
        async exec() {
          for (const doc of byEmail.values()) {
            if (matchesFilter(doc, filter)) return { ...doc };
          }
          return null;
        },
      };
    },
    async create(data: Record<string, unknown>) {
      const email = data.emailNormalized as string;
      if (byEmail.has(email)) {
        const err = new Error('Duplicate key') as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      idSeq += 1;
      const copy = { _id: `reg_${idSeq}`, ...data };
      byEmail.set(email, copy);
      return copy;
    },
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>
    ) {
      return {
        async exec() {
          for (const doc of byEmail.values()) {
            if (!matchesFilter(doc, filter)) continue;
            const set = update.$set as Record<string, unknown> | undefined;
            if (set) Object.assign(doc, set);
            const inc = update.$inc as Record<string, number> | undefined;
            if (inc) {
              for (const [k, v] of Object.entries(inc)) {
                doc[k] = ((doc[k] as number) ?? 0) + v;
              }
            }
            return { ...doc };
          }
          return null;
        },
      };
    },
  };
}

describe('P2-AUTH-04a: Pending Registration, OTP & Rate-Limiting Foundation', () => {
  describe('1. Nonce randomness, binding, and malformed-cookie rejection', () => {
    it('serializes production __Host-roundset_reg and dev roundset_reg cookies and rejects malformed values', () => {
      const prodCookie = serializeRegistrationCookie('regid_0123456789abcdef', 'nonce_0123456789abcdef', {
        isProduction: true,
      });
      expect(prodCookie).toContain('__Host-roundset_reg=reg1.regid_0123456789abcdef.nonce_0123456789abcdef');
      expect(prodCookie).toContain('Secure');
      expect(prodCookie).toContain('HttpOnly');
      expect(prodCookie).toContain('SameSite=Lax');
      expect(prodCookie).toContain('Path=/');
      expect(prodCookie).toContain('Max-Age=900');
      expect(prodCookie).not.toContain('Domain=');

      const devCookie = serializeRegistrationCookie('regid_0123456789abcdef', 'nonce_0123456789abcdef', {
        isProduction: false,
        isSecure: false,
      });
      expect(devCookie).toContain('roundset_reg=reg1.');
      expect(devCookie).not.toContain('__Host-');

      expect(
        parseRegistrationCookie('__Host-roundset_reg=reg1.regid_0123456789abcdef.nonce_0123456789abcdef', {
          isProduction: true,
        })
      ).toEqual({
        registrationId: 'regid_0123456789abcdef',
        nonce: 'nonce_0123456789abcdef',
      });

      // Malformed cookies
      expect(parseRegistrationCookie(undefined, { isProduction: true })).toBeNull();
      expect(parseRegistrationCookie('__Host-roundset_reg=wrong.a.b', { isProduction: true })).toBeNull();
      expect(parseRegistrationCookie('__Host-roundset_reg=reg1.short.short', { isProduction: true })).toBeNull();
      expect(parseRegistrationCookie('roundset_reg=reg1.regid_0123456789abcdef.nonce_0123456789abcdef', { isProduction: true })).toBeNull();

      const cleared = serializeClearRegistrationCookie({ isProduction: true });
      expect(cleared).toContain('__Host-roundset_reg=;');
      expect(cleared).toContain('Max-Age=0');
    });
  });

  describe('2-4. Registration replacement, cooldown, and combined register/resend limits', () => {
    it('enforces 60s replacement cooldown, 3/15m combined email cap, and invalidates old nonce/OTP on replacement', async () => {
      let currentTime = new Date('2026-11-27T10:00:00.000Z');
      const rateModel = createInMemoryRateLimitModel();
      const pendingModel = createInMemoryPendingRegistrationModel();
      const emailSender = new MockEmailSender({ nodeEnv: 'test', enableTestOtpCapture: true });
      const passwordService = createPasswordService();

      const rateLimitService = new AuthRateLimitService({
        rateLimitModel: rateModel as never,
        hmacSecret: TEST_HMAC_SECRET,
        now: () => currentTime,
      });

      const regService = new PendingRegistrationService({
        pendingRegistrationModel: pendingModel as never,
        rateLimitService,
        passwordService,
        emailSender,
        hmacSecret: TEST_HMAC_SECRET,
        now: () => currentTime,
      });

      // 1st registration
      const r1 = await regService.startOrReplaceRegistration({
        emailNormalized: 'candidate@example.com',
        password: 'Valid-Password-2026!',
        consentVersion: 'v1.0',
        trustedIp: '203.0.113.10',
      });
      const otp1 = emailSender.getTestOtp(r1.registrationId)!;
      expect(otp1).toMatch(/^\d{6}$/);

      // Immediate replacement within 60s -> rejected, must NOT overwrite r1
      await expect(
        regService.startOrReplaceRegistration({
          emailNormalized: 'candidate@example.com',
          password: 'Valid-Password-2026!',
          consentVersion: 'v1.0',
          trustedIp: '203.0.113.10',
        })
      ).rejects.toThrow(RateLimitExceededError);

      // r1 still verifiable after rejected replacement
      await expect(
        regService.claimAndVerifyRegistrationOtp({
          registrationId: r1.registrationId,
          nonce: r1.nonce,
          otpCode: otp1,
        })
      ).resolves.toMatchObject({ registrationId: r1.registrationId, version: 1 });

      // Advance 61s -> 2nd replacement succeeds and invalidates r1
      currentTime = new Date(currentTime.getTime() + 61_000);
      const r2 = await regService.startOrReplaceRegistration({
        emailNormalized: 'candidate@example.com',
        password: 'Valid-Password-2026!',
        consentVersion: 'v1.0',
        trustedIp: '203.0.113.10',
      });
      expect(r2.registrationId).not.toBe(r1.registrationId);
      await expect(
        regService.claimAndVerifyRegistrationOtp({
          registrationId: r1.registrationId,
          nonce: r1.nonce,
          otpCode: otp1,
        })
      ).rejects.toThrow(OtpInvalidError);

      // Advance 61s -> 3rd succeeds
      currentTime = new Date(currentTime.getTime() + 61_000);
      await regService.startOrReplaceRegistration({
        emailNormalized: 'candidate@example.com',
        password: 'Valid-Password-2026!',
        consentVersion: 'v1.0',
        trustedIp: '203.0.113.10',
      });

      // Advance 61s -> 4th within 15m hits combined 3/15m email cap
      currentTime = new Date(currentTime.getTime() + 61_000);
      await expect(
        regService.startOrReplaceRegistration({
          emailNormalized: 'candidate@example.com',
          password: 'Valid-Password-2026!',
          consentVersion: 'v1.0',
          trustedIp: '203.0.113.10',
        })
      ).rejects.toThrow(RateLimitExceededError);
    });
  });

  describe('5-11. OTP challenge security, atomic pre-claim, concurrency, and bindings', () => {
    it('generates uniform 6-digit codes and rejects expired, PENDING, FAILED, consumed, and wrong OTPs', async () => {
      let currentTime = new Date('2026-11-27T10:00:00.000Z');
      const challengeModel = createInMemoryChallengeModel();
      const otpService = new OtpChallengeService({
        challengeModel: challengeModel as never,
        hmacSecret: TEST_HMAC_SECRET,
        now: () => currentTime,
      });

      const subject: ChallengeSubjectInput = {
        purpose: 'RESET_PASSWORD',
        emailNormalized: 'user@example.com',
        userId: new Types.ObjectId(),
        passwordIdentityIdAtIssue: new Types.ObjectId(),
        identityVersionAtIssue: 1,
      };

      const issued = await otpService.issueChallenge(subject);
      expect(issued.otpCode).toMatch(/^\d{6}$/);
      expect(generateOtpCode()).toMatch(/^\d{6}$/);

      // PENDING delivery cannot verify
      await expect(
        otpService.claimAndVerifyAttempt(subject, issued.challengeId, issued.generation, issued.otpCode)
      ).rejects.toThrow(OtpInvalidError);

      // FAILED delivery cannot verify
      expect(await otpService.markDeliveryState(issued.challengeId, issued.generation, 'FAILED')).toBe(true);
      await expect(
        otpService.claimAndVerifyAttempt(subject, issued.challengeId, issued.generation, issued.otpCode)
      ).rejects.toThrow(OtpInvalidError);

      // Re-issue and mark ACCEPTED
      const issued2 = await otpService.issueChallenge(subject);
      expect(await otpService.markDeliveryState(issued2.challengeId, issued2.generation, 'ACCEPTED')).toBe(true);

      // Stale generation delivery update rejected
      expect(await otpService.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED')).toBe(false);

      // Wrong OTP rejected
      await expect(
        otpService.claimAndVerifyAttempt(subject, issued2.challengeId, issued2.generation, '000000')
      ).rejects.toThrow(OtpInvalidError);

      // Correct OTP succeeds
      await expect(
        otpService.claimAndVerifyAttempt(subject, issued2.challengeId, issued2.generation, issued2.otpCode)
      ).resolves.toMatchObject({ challengeId: issued2.challengeId, generation: issued2.generation });

      // Expired challenge rejected
      currentTime = new Date(currentTime.getTime() + 6 * 60_000);
      await expect(
        otpService.claimAndVerifyAttempt(subject, issued2.challengeId, issued2.generation, issued2.otpCode)
      ).rejects.toThrow(OtpInvalidError);
    });

    it('enforces max 5 digest comparisons across 20 parallel guesses', async () => {
      const challengeModel = createInMemoryChallengeModel();
      const compareSpy = vi.fn(compareDigestConstantTime);
      const otpService = new OtpChallengeService({
        challengeModel: challengeModel as never,
        hmacSecret: TEST_HMAC_SECRET,
        compareDigest: compareSpy,
      });

      const subject: ChallengeSubjectInput = {
        purpose: 'PHONE_VERIFY',
        phoneE164: '+14155552671',
        userId: new Types.ObjectId(),
      };
      const issued = await otpService.issueChallenge(subject);
      await otpService.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED');

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          otpService.claimAndVerifyAttempt(subject, issued.challengeId, issued.generation, '999999')
        )
      );

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(compareSpy).toHaveBeenCalledTimes(5);
    });

    it('rejects recovery user/identityId/version mismatch and cross-purpose/cross-user challenges', async () => {
      const challengeModel = createInMemoryChallengeModel();
      const otpService = new OtpChallengeService({
        challengeModel: challengeModel as never,
        hmacSecret: TEST_HMAC_SECRET,
      });

      const userId = new Types.ObjectId();
      const pwId = new Types.ObjectId();
      const subject: ChallengeSubjectInput = {
        purpose: 'RESET_PASSWORD',
        emailNormalized: 'user@example.com',
        userId,
        passwordIdentityIdAtIssue: pwId,
        identityVersionAtIssue: 3,
      };
      const issued = await otpService.issueChallenge(subject);
      await otpService.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED');

      // Version mismatch
      await expect(
        otpService.claimAndVerifyAttempt(
          { ...subject, identityVersionAtIssue: 4 },
          issued.challengeId,
          issued.generation,
          issued.otpCode
        )
      ).rejects.toThrow(OtpInvalidError);

      // User mismatch
      await expect(
        otpService.claimAndVerifyAttempt(
          { ...subject, userId: new Types.ObjectId() },
          issued.challengeId,
          issued.generation,
          issued.otpCode
        )
      ).rejects.toThrow(OtpInvalidError);

      // Identity ID mismatch
      await expect(
        otpService.claimAndVerifyAttempt(
          { ...subject, passwordIdentityIdAtIssue: new Types.ObjectId() },
          issued.challengeId,
          issued.generation,
          issued.otpCode
        )
      ).rejects.toThrow(OtpInvalidError);

      // Cross-purpose digest isolation
      const resetDigest = computeSubjectDigest(TEST_HMAC_SECRET, subject);
      const linkDigest = computeSubjectDigest(TEST_HMAC_SECRET, {
        purpose: 'LINK_PASSWORD',
        emailNormalized: 'user@example.com',
        userId,
        sessionId: 'sess_1',
        reauthTicketDigest: 'tkt_1',
      });
      expect(resetDigest).not.toBe(linkDigest);

      const otpDigest = computeOtpDigest(TEST_HMAC_SECRET, 'RESET_PASSWORD', resetDigest, issued.challengeId, 1, issued.otpCode);
      expect(otpDigest).toHaveLength(64);
    });
  });

  describe('12-17. Persistent rate limits, flood shedding, IP spoofing, and production mock refusal', () => {
    it('persists rate limits across service recreation and enforces final-slot concurrency', async () => {
      const rateModel = createInMemoryRateLimitModel();
      const service1 = new AuthRateLimitService({
        rateLimitModel: rateModel as never,
        hmacSecret: TEST_HMAC_SECRET,
      });

      await service1.consumeOrThrow('PASSWORD_FORGOT_EMAIL', 'a@example.com');
      await service1.consumeOrThrow('PASSWORD_FORGOT_EMAIL', 'a@example.com');

      // Recreate service (simulates process restart)
      const service2 = new AuthRateLimitService({
        rateLimitModel: rateModel as never,
        hmacSecret: TEST_HMAC_SECRET,
      });

      // Concurrent 2 requests competing for the 3rd (final) slot
      const outcomes = await Promise.allSettled([
        service2.consumeOrThrow('PASSWORD_FORGOT_EMAIL', 'a@example.com'),
        service2.consumeOrThrow('PASSWORD_FORGOT_EMAIL', 'a@example.com'),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RateLimitExceededError);
    });

    it('ignores caller X-Forwarded-For, bounds flood shedder memory, and refuses MockEmailSender in production', async () => {
      const spoofedReq = {
        clientIp: undefined,
        headers: { 'x-forwarded-for': '1.2.3.4' },
      } as unknown as Request;
      expect(extractTrustedClientIp(spoofedReq)).toBe('unknown');

      const shedder = new InProcessFloodShedder({
        perIpLimitPerMinute: 60,
        globalLimitPerMinute: 120,
        maxTrackedIps: 50,
      });
      for (let i = 0; i < 100; i += 1) {
        shedder.consumeOrThrow(`198.51.100.${i}`);
      }
      expect(shedder.getTrackedIpCount()).toBeLessThanOrEqual(50);

      expect(() => new MockEmailSender({ nodeEnv: 'production' })).toThrow(ForbiddenError);
      const devSender: EmailSender = new MockEmailSender({ nodeEnv: 'test' });
      expect(devSender.providerName).toBe('mock');

      // Raw OTP capture is disabled unless explicitly opted in
      await devSender.sendOtpEmail({
        purpose: 'REGISTER_VERIFY',
        toEmail: 'a@example.com',
        otpCode: '123456',
        correlationId: 'corr_1',
        generation: 1,
      });
      expect((devSender as MockEmailSender).getTestOtp('corr_1')).toBeUndefined();
    });

    it('enforces unforgeable verified-proof capability and active ClientSession transaction', async () => {
      const challengeModel = createInMemoryChallengeModel();
      const otpService = new OtpChallengeService({
        challengeModel: challengeModel as never,
        hmacSecret: TEST_HMAC_SECRET,
      });

      const subject: ChallengeSubjectInput = {
        purpose: 'PHONE_VERIFY',
        phoneE164: '+14155552671',
        userId: new Types.ObjectId(),
      };
      const issued = await otpService.issueChallenge(subject);
      await otpService.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED');

      const forgedProof = {
        challengeId: issued.challengeId,
        purpose: issued.purpose,
        subjectDigest: issued.subjectDigest,
        generation: issued.generation,
        expiresAt: issued.expiresAt,
        input: subject,
      } as VerifiedOtpChallengeProof;

      const activeSession = { inTransaction: () => true } as never;
      const inactiveSession = { inTransaction: () => false } as never;

      // Forged proof rejected
      await expect(otpService.consumeVerifiedChallenge(forgedProof, activeSession)).rejects.toThrow(
        OtpInvalidError
      );

      // Valid proof with inactive transaction rejected
      const realProof = await otpService.claimAndVerifyAttempt(
        subject,
        issued.challengeId,
        issued.generation,
        issued.otpCode
      );
      await expect(
        otpService.consumeVerifiedChallenge(realProof, inactiveSession)
      ).rejects.toThrow('Active ClientSession transaction is required');

      // Valid proof with active transaction succeeds
      await expect(
        otpService.consumeVerifiedChallenge(realProof, activeSession)
      ).resolves.toBeUndefined();
    });

    it('supports browser-bound resend, prevents orphan emails on CAS exhaustion, and maps email exceptions', async () => {
      let currentTime = new Date('2026-11-27T10:00:00.000Z');
      const rateModel = createInMemoryRateLimitModel();
      const pendingModel = createInMemoryPendingRegistrationModel();
      const emailSender = new MockEmailSender({ nodeEnv: 'test', enableTestOtpCapture: true });
      const passwordService = createPasswordService();
      const rateLimitService = new AuthRateLimitService({
        rateLimitModel: rateModel as never,
        hmacSecret: TEST_HMAC_SECRET,
        now: () => currentTime,
      });

      const regService = new PendingRegistrationService({
        pendingRegistrationModel: pendingModel as never,
        rateLimitService,
        passwordService,
        emailSender,
        hmacSecret: TEST_HMAC_SECRET,
        now: () => currentTime,
      });

      const r1 = await regService.startOrReplaceRegistration({
        emailNormalized: 'resend@example.com',
        password: 'Valid-Password-2026!',
        consentVersion: 'v1.0',
        trustedIp: '203.0.113.20',
      });
      const otp1 = emailSender.getTestOtp(r1.registrationId)!;

      // Advance 61s and resend with valid registrationId + nonce
      currentTime = new Date(currentTime.getTime() + 61_000);
      const resendRes = await regService.resendRegistrationOtp({
        registrationId: r1.registrationId,
        nonce: r1.nonce,
        trustedIp: '203.0.113.20',
      });
      expect(resendRes.version).toBe(2);
      expect(resendRes.deliveryAccepted).toBe(true);
      const otp2 = emailSender.getTestOtp(r1.registrationId)!;
      expect(otp2).not.toBe(otp1);

      // Old OTP1 no longer works
      await expect(
        regService.claimAndVerifyRegistrationOtp({
          registrationId: r1.registrationId,
          nonce: r1.nonce,
          otpCode: otp1,
        })
      ).rejects.toThrow(OtpInvalidError);

      // New OTP2 works
      await expect(
        regService.claimAndVerifyRegistrationOtp({
          registrationId: r1.registrationId,
          nonce: r1.nonce,
          otpCode: otp2,
        })
      ).resolves.toMatchObject({ registrationId: r1.registrationId, version: 2 });

      // Flood shedder middleware sets Retry-After on 429
      const shedder = new InProcessFloodShedder({ perIpLimitPerMinute: 1, globalLimitPerMinute: 10 });
      const mw = createFloodShedderMiddleware(shedder);
      const headers: Record<string, string> = {};
      const next1 = vi.fn();
      mw({ clientIp: '198.51.100.9' } as never, { setHeader: (k: string, v: string) => { headers[k] = v; } } as never, next1);
      expect(next1).toHaveBeenCalledWith();
      const next2 = vi.fn();
      mw({ clientIp: '198.51.100.9' } as never, { setHeader: (k: string, v: string) => { headers[k] = v; } } as never, next2);
      expect(headers['Retry-After']).toBeDefined();
      expect(next2.mock.calls[0]?.[0]).toBeInstanceOf(RateLimitExceededError);
    });

    it('supports transaction-abort retry with same proof, concurrent single-winner consumption, immutable proof bindings, and delayed-registration ordering', async () => {
      const challengeModel = createInMemoryChallengeModel();
      const otpService = new OtpChallengeService({
        challengeModel: challengeModel as never,
        hmacSecret: TEST_HMAC_SECRET,
      });

      const mutableInput: ChallengeSubjectInput = {
        purpose: 'RESET_PASSWORD',
        emailNormalized: 'retry@example.com',
        userId: new Types.ObjectId(),
        passwordIdentityIdAtIssue: new Types.ObjectId(),
        identityVersionAtIssue: 1,
      };

      const issued = await otpService.issueChallenge(mutableInput);
      await otpService.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED');

      const proof = await otpService.claimAndVerifyAttempt(
        mutableInput,
        issued.challengeId,
        issued.generation,
        issued.otpCode
      );

      // Mutate caller-owned input after verification
      mutableInput.identityVersionAtIssue = 999;

      // Simulate transaction abort: consume, then roll back DB state to ISSUED
      const activeSession = { inTransaction: () => true } as never;
      await otpService.consumeVerifiedChallenge(proof, activeSession);
      const storedDoc = Array.from(challengeModel.docs.values())[0]!;
      storedDoc.state = 'ISSUED';
      delete storedDoc.consumedAt;

      // Retry with the exact same proof: concurrent consumption yields only 1 winner
      const outcomes = await Promise.allSettled([
        otpService.consumeVerifiedChallenge(proof, activeSession),
        otpService.consumeVerifiedChallenge(proof, activeSession),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

      // Interleaved deferred-promise regression: earlier delayed registration cannot overwrite newer one
      let currentTime = new Date('2026-11-27T10:00:00.000Z');
      const rateModel = createInMemoryRateLimitModel();
      const pendingModel = createInMemoryPendingRegistrationModel();
      const emailSender = new MockEmailSender({ nodeEnv: 'test', enableTestOtpCapture: true });
      const rateLimitService = new AuthRateLimitService({
        rateLimitModel: rateModel as never,
        hmacSecret: TEST_HMAC_SECRET,
        now: () => currentTime,
      });

      let releaseFirstHash!: (hash: string) => void;
      const firstHashGate = new Promise<string>((resolve) => {
        releaseFirstHash = resolve;
      });
      let signalFirstHashStarted!: () => void;
      const firstHashStarted = new Promise<void>((resolve) => {
        signalFirstHashStarted = resolve;
      });
      let hashCallCount = 0;
      const mockPasswordService = {
        hashPassword: vi.fn(async () => {
          hashCallCount += 1;
          if (hashCallCount === 1) {
            signalFirstHashStarted();
            return firstHashGate;
          }
          return '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        }),
      };

      const regService = new PendingRegistrationService({
        pendingRegistrationModel: pendingModel as never,
        rateLimitService,
        passwordService: mockPasswordService as never,
        emailSender,
        hmacSecret: TEST_HMAC_SECRET,
        now: () => currentTime,
      });

      // Start R1 at t=0; it passes durable cooldown then suspends in hashPassword
      const r1Promise = regService.startOrReplaceRegistration({
        emailNormalized: 'order@example.com',
        password: 'Valid-Password-2026!',
        consentVersion: 'v1.0',
        trustedIp: '203.0.113.30',
      });
      await firstHashStarted;

      // Advance 61s and complete R2
      currentTime = new Date(currentTime.getTime() + 61_000);
      const r2 = await regService.startOrReplaceRegistration({
        emailNormalized: 'order@example.com',
        password: 'Valid-Password-2026!',
        consentVersion: 'v1.0',
        trustedIp: '203.0.113.30',
      });
      // Stamp updatedAt as Mongoose timestamps:true would
      pendingModel.byEmail.get('order@example.com')!.updatedAt = currentTime;

      // Resume R1: must be rejected with 409 CONFLICT and leave R2 intact
      releaseFirstHash('$argon2id$v=19$m=19456,t=2,p=1$BBBBBBBBBBBBBBBBBBBBBB$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
      await expect(r1Promise).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      expect(pendingModel.byEmail.get('order@example.com')!.registrationId).toBe(r2.registrationId);
    });
  });
});
