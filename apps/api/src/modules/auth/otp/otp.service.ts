import crypto from 'node:crypto';
import type { ClientSession, Model, Types } from 'mongoose';
import type { IVerificationChallenge } from '../../identity/models/verification-challenge.model.js';
import type { IUser } from '../../identity/models/user.model.js';
import type { IAuthIdentity } from '../../identity/models/auth-identity.model.js';
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
  type VerifiedOtpChallengeProof,
} from './types.js';

/**
 * Private runtime capability registry. Only `claimAndVerifyAttempt` may
 * register a `VerifiedOtpChallengeProof`, preventing caller-constructed objects
 * from authorizing consumption.
 */
const issuedOtpProofs = new WeakSet<VerifiedOtpChallengeProof>();

export interface OtpChallengeServiceOptions {
  challengeModel: Model<IVerificationChallenge>;
  hmacSecret: string;
  now?: () => Date;
  compareDigest?: (actual: string, expected: string) => boolean;
}

export interface VerifyRecoveryBindingParams {
  userModel: Model<IUser>;
  authIdentityModel: Model<IAuthIdentity>;
  userId: Types.ObjectId;
  passwordIdentityIdAtIssue: Types.ObjectId;
  identityVersionAtIssue: number;
  emailNormalized: string;
  session?: ClientSession;
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
   * Returns an unforgeable `VerifiedOtpChallengeProof` capability on success.
   */
  async claimAndVerifyAttempt(
    input: ChallengeSubjectInput,
    challengeId: string,
    generation: number,
    otpCode: string
  ): Promise<VerifiedOtpChallengeProof> {
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

    const proof: VerifiedOtpChallengeProof = Object.freeze({
      challengeId: claimed.challengeId,
      purpose: input.purpose,
      subjectDigest,
      generation: claimed.generation,
      expiresAt: claimed.expiresAt,
      input,
    });
    issuedOtpProofs.add(proof);
    return proof;
  }

  /**
   * Verifies that a RESET_PASSWORD challenge's bound userId, passwordIdentityIdAtIssue,
   * identityVersionAtIssue, ACTIVE status, and canonical email match current DB state.
   *
   * Mandatory for P2-AUTH-03b: `POST /auth/password/reset` must call this within the
   * same `ClientSession` transaction as `consumeVerifiedChallenge` AND perform a guarded
   * `users.findOneAndUpdate({ _id: userId, accountStatus: 'ACTIVE', identityVersion: identityVersionAtIssue, emailNormalized }, { $inc: { identityVersion: 1, sessionEpoch: 1 } })`
   * to prevent check-then-mutate races.
   */
  async verifyAuthoritativeRecoveryBinding(
    params: VerifyRecoveryBindingParams
  ): Promise<void> {
    const user = await params.userModel
      .findOne(
        {
          _id: params.userId,
          accountStatus: 'ACTIVE',
          emailNormalized: params.emailNormalized,
          identityVersion: params.identityVersionAtIssue,
        },
        null,
        params.session ? { session: params.session } : undefined
      )
      .exec();

    if (!user) {
      throw new OtpInvalidError();
    }

    const identity = await params.authIdentityModel
      .findOne(
        {
          _id: params.passwordIdentityIdAtIssue,
          userId: params.userId,
          provider: 'PASSWORD',
        },
        null,
        params.session ? { session: params.session } : undefined
      )
      .exec();

    if (!identity) {
      throw new OtpInvalidError();
    }
  }

  /**
   * Transaction-aware consumption primitive requiring an unforgeable
   * `VerifiedOtpChallengeProof` and an active `ClientSession` transaction.
   */
  async consumeVerifiedChallenge(
    proof: VerifiedOtpChallengeProof,
    session: ClientSession
  ): Promise<void> {
    if (!proof || !issuedOtpProofs.has(proof)) {
      throw new OtpInvalidError();
    }
    if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) {
      throw new Error('Active ClientSession transaction is required for challenge consumption');
    }

    const currentNow = this.now();
    if (proof.expiresAt <= currentNow) {
      throw new OtpInvalidError();
    }

    const bindingFilter = buildBindingFilter(proof.input);

    const consumed = await this.challengeModel
      .findOneAndUpdate(
        {
          challengeId: proof.challengeId,
          purpose: proof.purpose,
          subjectDigest: proof.subjectDigest,
          generation: proof.generation,
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

    issuedOtpProofs.delete(proof);
  }
}
