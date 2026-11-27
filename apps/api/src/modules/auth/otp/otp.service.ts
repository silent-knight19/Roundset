import crypto from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import type { IVerificationChallenge } from '../../identity/models/verification-challenge.model.js';
import {
  compareDigestConstantTime,
  computeOtpDigest,
  computeSubjectDigest,
  generateOtpCode,
} from './crypto.js';
import {
  OTP_POLICY,
  OtpInvalidError,
  type ChallengeSubjectInput,
  type IssuedChallengeResult,
} from './types.js';

export interface OtpChallengeServiceOptions {
  challengeModel: Model<IVerificationChallenge>;
  hmacSecret: string;
  now?: () => Date;
  compareDigest?: (actual: string, expected: string) => boolean;
}

function buildBindingFilter(input: ChallengeSubjectInput): Record<string, unknown> {
  switch (input.purpose) {
    case 'RESET_PASSWORD':
      return {
        userId: input.userId,
        passwordIdentityIdAtIssue: input.passwordIdentityIdAtIssue,
        identityVersionAtIssue: input.identityVersionAtIssue,
      };
    case 'LINK_PASSWORD':
      return {
        userId: input.userId,
        sessionId: input.sessionId,
        reauthTicketDigest: input.reauthTicketDigest,
      };
    case 'PHONE_VERIFY':
      return {
        userId: input.userId,
      };
  }
}

export class OtpChallengeService {
  private readonly challengeModel: Model<IVerificationChallenge>;
  private readonly hmacSecret: string;
  private readonly now: () => Date;
  private readonly compareDigest: (actual: string, expected: string) => boolean;

  constructor(options: OtpChallengeServiceOptions) {
    this.challengeModel = options.challengeModel;
    this.hmacSecret = options.hmacSecret;
    this.now = options.now ?? (() => new Date());
    this.compareDigest = options.compareDigest ?? compareDigestConstantTime;
  }

  /**
   * Issues or atomically replaces the single mutable challenge slot for (purpose, subjectDigest).
   * Generates a fresh challengeId, increments generation, resets attempts to 0,
   * and sets deliveryState to PENDING.
   */
  async issueChallenge(input: ChallengeSubjectInput): Promise<IssuedChallengeResult> {
    const subjectDigest = computeSubjectDigest(this.hmacSecret, input);
    const currentNow = this.now();
    const expiresAt = new Date(currentNow.getTime() + OTP_POLICY.ttlMs);
    const otpCode = generateOtpCode();
    const challengeId = `chl_${crypto.randomBytes(16).toString('hex')}`;
    const bindingFields = buildBindingFilter(input);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.challengeModel
        .findOne({ purpose: input.purpose, subjectDigest })
        .exec();

      if (!existing) {
        const generation = 1;
        const otpDigest = computeOtpDigest(
          this.hmacSecret,
          input.purpose,
          subjectDigest,
          challengeId,
          generation,
          otpCode
        );

        try {
          await this.challengeModel.create({
            challengeId,
            purpose: input.purpose,
            subjectDigest,
            ...bindingFields,
            otpDigest,
            generation,
            attempts: 0,
            resendCount: 0,
            state: 'ISSUED',
            deliveryState: 'PENDING',
            expiresAt,
            createdAt: currentNow,
          });
          return {
            challengeId,
            purpose: input.purpose,
            subjectDigest,
            generation,
            expiresAt,
            otpCode,
          };
        } catch (err: unknown) {
          const code = (err as { code?: number })?.code;
          if (code === 11000) {
            continue;
          }
          throw err;
        }
      }

      const nextGeneration = existing.generation + 1;
      const otpDigest = computeOtpDigest(
        this.hmacSecret,
        input.purpose,
        subjectDigest,
        challengeId,
        nextGeneration,
        otpCode
      );

      const updated = await this.challengeModel
        .findOneAndUpdate(
          {
            _id: existing._id,
            generation: existing.generation,
          },
          {
            $set: {
              challengeId,
              ...bindingFields,
              otpDigest,
              generation: nextGeneration,
              attempts: 0,
              state: 'ISSUED',
              deliveryState: 'PENDING',
              expiresAt,
              createdAt: currentNow,
            },
            $unset: { consumedAt: '' },
            $inc: { resendCount: 1 },
          },
          { new: true }
        )
        .exec();

      if (updated) {
        return {
          challengeId,
          purpose: input.purpose,
          subjectDigest,
          generation: nextGeneration,
          expiresAt,
          otpCode,
        };
      }
    }

    throw new OtpInvalidError('Concurrent challenge issuance conflict');
  }

  /**
   * CAS-checked delivery state update matching the exact winning generation.
   */
  async markDeliveryState(
    challengeId: string,
    generation: number,
    deliveryState: 'ACCEPTED' | 'FAILED'
  ): Promise<boolean> {
    const updated = await this.challengeModel
      .findOneAndUpdate(
        {
          challengeId,
          generation,
          state: 'ISSUED',
          deliveryState: 'PENDING',
        },
        {
          $set: { deliveryState },
        },
        { new: true }
      )
      .exec();

    return updated !== null;
  }

  /**
   * Atomically claims 1 of max 5 attempt slots in MongoDB BEFORE comparing any OTP digest.
   * A 6th concurrent request, expired challenge, or PENDING/FAILED delivery never reaches
   * digest comparison.
   */
  async claimAndVerifyAttempt(
    input: ChallengeSubjectInput,
    challengeId: string,
    generation: number,
    otpCode: string
  ): Promise<{ challengeId: string; generation: number; subjectDigest: string }> {
    const subjectDigest = computeSubjectDigest(this.hmacSecret, input);
    const currentNow = this.now();
    const bindingFilter = buildBindingFilter(input);

    const claimed = await this.challengeModel
      .findOneAndUpdate(
        {
          challengeId,
          purpose: input.purpose,
          subjectDigest,
          generation,
          state: 'ISSUED',
          deliveryState: 'ACCEPTED',
          expiresAt: { $gt: currentNow },
          attempts: { $lt: OTP_POLICY.maxAttempts },
          ...bindingFilter,
        },
        {
          $inc: { attempts: 1 },
        },
        { new: true }
      )
      .exec();

    if (!claimed) {
      throw new OtpInvalidError();
    }

    const expectedDigest = computeOtpDigest(
      this.hmacSecret,
      input.purpose,
      subjectDigest,
      challengeId,
      generation,
      otpCode
    );

    if (!this.compareDigest(expectedDigest, claimed.otpDigest)) {
      throw new OtpInvalidError();
    }

    return {
      challengeId: claimed.challengeId,
      generation: claimed.generation,
      subjectDigest,
    };
  }

  /**
   * Transaction-aware consumption primitive accepting the caller's ClientSession.
   * Must be executed inside an active MongoDB replica-set transaction alongside
   * the protected credential/account mutation.
   */
  async consumeVerifiedChallenge(
    input: ChallengeSubjectInput,
    challengeId: string,
    generation: number,
    session: ClientSession
  ): Promise<void> {
    if (!session) {
      throw new Error('ClientSession is required for transactional challenge consumption');
    }

    const subjectDigest = computeSubjectDigest(this.hmacSecret, input);
    const currentNow = this.now();
    const bindingFilter = buildBindingFilter(input);

    const consumed = await this.challengeModel
      .findOneAndUpdate(
        {
          challengeId,
          purpose: input.purpose,
          subjectDigest,
          generation,
          state: 'ISSUED',
          deliveryState: 'ACCEPTED',
          expiresAt: { $gt: currentNow },
          ...bindingFilter,
        },
        {
          $set: {
            state: 'CONSUMED',
            consumedAt: currentNow,
          },
        },
        { new: true, session }
      )
      .exec();

    if (!consumed) {
      throw new OtpInvalidError();
    }
  }
}
