import crypto from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { HttpError } from '../../../core/errors.js';
import type { IPendingRegistration } from '../../identity/models/pending-registration.model.js';
import type { EmailSender } from '../email/types.js';
import {
  compareDigestConstantTime,
  computeDomainHmac,
  generateOtpCode,
} from '../otp/crypto.js';
import { OTP_POLICY, OtpInvalidError } from '../otp/types.js';
import type { PasswordService } from '../password/password.service.js';
import type { AuthRateLimitService } from '../rate-limit/rate-limit.service.js';

export const PENDING_REGISTRATION_POLICY = {
  ttlMs: 15 * 60_000,
  otpTtlMs: 5 * 60_000,
  maxAttempts: OTP_POLICY.maxAttempts,
  registrationIdBytes: 16, // 128 bits
  nonceBytes: 32, // 256 bits
} as const;

export interface VerifiedRegistrationProof {
  readonly registrationId: string;
  readonly version: number;
  readonly emailNormalized: string;
  readonly nonceDigest: string;
  readonly expiresAt: Date;
}

interface ImmutableRegistrationProofMetadata {
  readonly registrationId: string;
  readonly version: number;
  readonly emailNormalized: string;
  readonly nonceDigest: string;
  readonly expiresAtMs: number;
}

const issuedRegistrationProofs = new WeakMap<
  VerifiedRegistrationProof,
  ImmutableRegistrationProofMetadata
>();

export interface PendingRegistrationServiceOptions {
  pendingRegistrationModel: Model<IPendingRegistration>;
  rateLimitService: AuthRateLimitService;
  passwordService: PasswordService;
  emailSender: EmailSender;
  hmacSecret: string;
  now?: () => Date;
  compareDigest?: (actual: string, expected: string) => boolean;
}

export interface StartRegistrationInput {
  emailNormalized: string;
  password: string;
  consentVersion: string;
  displayName?: string;
  trustedIp: string;
}

export interface StartRegistrationResult {
  registrationId: string;
  nonce: string;
  version: number;
  deliveryAccepted: boolean;
  expiresAt: Date;
  otpExpiresAt: Date;
}

export interface ResendRegistrationInput {
  registrationId: string;
  nonce: string;
  trustedIp: string;
}

export interface ResendRegistrationResult {
  registrationId: string;
  version: number;
  deliveryAccepted: boolean;
  otpExpiresAt: Date;
}

export class PendingRegistrationService {
  private readonly pendingModel: Model<IPendingRegistration>;
  private readonly rateLimitService: AuthRateLimitService;
  private readonly passwordService: PasswordService;
  private readonly emailSender: EmailSender;
  private readonly hmacSecret: string;
  private readonly now: () => Date;
  private readonly compareDigest: (actual: string, expected: string) => boolean;

  constructor(options: PendingRegistrationServiceOptions) {
    this.pendingModel = options.pendingRegistrationModel;
    this.rateLimitService = options.rateLimitService;
    this.passwordService = options.passwordService;
    this.emailSender = options.emailSender;
    this.hmacSecret = options.hmacSecret;
    this.now = options.now ?? (() => new Date());
    this.compareDigest = options.compareDigest ?? compareDigestConstantTime;
  }

  /**
   * Starts or atomically replaces a pending registration by canonical email.
   * Enforces IP cap, replacement cooldown, and combined email budget BEFORE
   * touching pendingRegistrations. Never sends an email unless persistence succeeded.
   */
  async startOrReplaceRegistration(
    input: StartRegistrationInput
  ): Promise<StartRegistrationResult> {
    await this.rateLimitService.consumeOrThrow('REGISTER_RESEND_IP', input.trustedIp);
    await this.rateLimitService.consumeOrThrow(
      'REGISTER_REPLACE_COOLDOWN',
      input.emailNormalized
    );
    await this.rateLimitService.consumeOrThrow(
      'REGISTER_RESEND_EMAIL',
      input.emailNormalized
    );

    const admissionTime = this.now();
    const passwordHash = await this.passwordService.hashPassword(input.password);

    const registrationId = crypto
      .randomBytes(PENDING_REGISTRATION_POLICY.registrationIdBytes)
      .toString('hex');
    const nonce = crypto
      .randomBytes(PENDING_REGISTRATION_POLICY.nonceBytes)
      .toString('base64url');
    const otpCode = generateOtpCode();
    const currentNow = this.now();
    const expiresAt = new Date(currentNow.getTime() + PENDING_REGISTRATION_POLICY.ttlMs);
    const otpExpiresAt = new Date(
      currentNow.getTime() + PENDING_REGISTRATION_POLICY.otpTtlMs
    );

    const nonceDigest = computeDomainHmac(this.hmacSecret, [
      'REG_NONCE',
      registrationId,
      nonce,
    ]);

    let version = 1;
    let persisted = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.pendingModel
        .findOne({ emailNormalized: input.emailNormalized })
        .exec();

      if (!existing) {
        const otpDigest = computeDomainHmac(this.hmacSecret, [
          'REG_OTP',
          registrationId,
          '1',
          otpCode,
        ]);
        try {
          await this.pendingModel.create({
            registrationId,
            emailNormalized: input.emailNormalized,
            passwordHash,
            nonceDigest,
            otpDigest,
            version: 1,
            attempts: 0,
            resendCount: 0,
            state: 'PENDING_DELIVERY',
            deliveryState: 'PENDING',
            otpExpiresAt,
            expiresAt,
            consentVersion: input.consentVersion,
            displayName: input.displayName,
          });
          version = 1;
          persisted = true;
          break;
        } catch (err: unknown) {
          const code = (err as { code?: number })?.code;
          if (code === 11000) {
            continue;
          }
          throw err;
        }
      }

      if (existing.updatedAt && existing.updatedAt > admissionTime) {
        throw new HttpError(409, 'CONFLICT', 'Concurrent registration conflict');
      }

      const nextVersion = existing.version + 1;
      const otpDigest = computeDomainHmac(this.hmacSecret, [
        'REG_OTP',
        registrationId,
        String(nextVersion),
        otpCode,
      ]);

      const updated = await this.pendingModel
        .findOneAndUpdate(
          {
            _id: existing._id,
            version: existing.version,
            ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
          },
          {
            $set: {
              registrationId,
              passwordHash,
              nonceDigest,
              otpDigest,
              version: nextVersion,
              attempts: 0,
              state: 'PENDING_DELIVERY',
              deliveryState: 'PENDING',
              otpExpiresAt,
              expiresAt,
              consentVersion: input.consentVersion,
              displayName: input.displayName,
            },
            $inc: { resendCount: 1 },
          },
          { new: true }
        )
        .exec();

      if (updated) {
        version = nextVersion;
        persisted = true;
        break;
      }
    }

    if (!persisted) {
      throw new HttpError(409, 'CONFLICT', 'Concurrent registration conflict');
    }

    const deliveryAccepted = await this.dispatchAndRecordDelivery(
      registrationId,
      version,
      input.emailNormalized,
      otpCode
    );

    return {
      registrationId,
      nonce,
      version,
      deliveryAccepted,
      expiresAt,
      otpExpiresAt,
    };
  }

  /**
   * Browser-bound registration resend primitive.
   * Preserves existing passwordHash, nonceDigest, and registration expiresAt,
   * while advancing version, resetting attempts, and issuing a fresh 5m OTP.
   */
  async resendRegistrationOtp(
    input: ResendRegistrationInput
  ): Promise<ResendRegistrationResult> {
    await this.rateLimitService.consumeOrThrow('REGISTER_RESEND_IP', input.trustedIp);

    const currentNow = this.now();
    const expectedNonceDigest = computeDomainHmac(this.hmacSecret, [
      'REG_NONCE',
      input.registrationId,
      input.nonce,
    ]);

    const existing = await this.pendingModel
      .findOne({
        registrationId: input.registrationId,
        nonceDigest: expectedNonceDigest,
        state: { $in: ['PENDING_DELIVERY', 'SENT'] },
        expiresAt: { $gt: currentNow },
      })
      .exec();

    if (!existing) {
      throw new OtpInvalidError();
    }

    await this.rateLimitService.consumeOrThrow(
      'REGISTER_REPLACE_COOLDOWN',
      existing.emailNormalized
    );
    await this.rateLimitService.consumeOrThrow(
      'REGISTER_RESEND_EMAIL',
      existing.emailNormalized
    );

    const nextVersion = existing.version + 1;
    const otpCode = generateOtpCode();
    const otpExpiresAt = new Date(
      currentNow.getTime() + PENDING_REGISTRATION_POLICY.otpTtlMs
    );
    const otpDigest = computeDomainHmac(this.hmacSecret, [
      'REG_OTP',
      existing.registrationId,
      String(nextVersion),
      otpCode,
    ]);

    const updated = await this.pendingModel
      .findOneAndUpdate(
        {
          _id: existing._id,
          registrationId: existing.registrationId,
          nonceDigest: expectedNonceDigest,
          version: existing.version,
          state: { $in: ['PENDING_DELIVERY', 'SENT'] },
          expiresAt: { $gt: currentNow },
        },
        {
          $set: {
            otpDigest,
            version: nextVersion,
            attempts: 0,
            state: 'PENDING_DELIVERY',
            deliveryState: 'PENDING',
            otpExpiresAt,
          },
          $inc: { resendCount: 1 },
        },
        { new: true }
      )
      .exec();

    if (!updated) {
      throw new OtpInvalidError();
    }

    const deliveryAccepted = await this.dispatchAndRecordDelivery(
      updated.registrationId,
      nextVersion,
      updated.emailNormalized,
      otpCode
    );

    return {
      registrationId: updated.registrationId,
      version: nextVersion,
      deliveryAccepted,
      otpExpiresAt,
    };
  }

  /**
   * Atomically claims 1 of 5 OTP attempt slots BEFORE comparing the OTP digest.
   * Returns an unforgeable `VerifiedRegistrationProof` capability on success.
   */
  async claimAndVerifyRegistrationOtp(params: {
    registrationId: string;
    nonce: string;
    otpCode: string;
  }): Promise<VerifiedRegistrationProof> {
    const currentNow = this.now();
    const expectedNonceDigest = computeDomainHmac(this.hmacSecret, [
      'REG_NONCE',
      params.registrationId,
      params.nonce,
    ]);

    const claimed = await this.pendingModel
      .findOneAndUpdate(
        {
          registrationId: params.registrationId,
          nonceDigest: expectedNonceDigest,
          state: 'SENT',
          deliveryState: 'ACCEPTED',
          otpExpiresAt: { $gt: currentNow },
          expiresAt: { $gt: currentNow },
          attempts: { $lt: PENDING_REGISTRATION_POLICY.maxAttempts },
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

    const expectedOtpDigest = computeDomainHmac(this.hmacSecret, [
      'REG_OTP',
      claimed.registrationId,
      String(claimed.version),
      params.otpCode,
    ]);

    if (!this.compareDigest(expectedOtpDigest, claimed.otpDigest)) {
      throw new OtpInvalidError();
    }

    const proof: VerifiedRegistrationProof = Object.freeze({
      registrationId: claimed.registrationId,
      version: claimed.version,
      emailNormalized: claimed.emailNormalized,
      nonceDigest: claimed.nonceDigest,
      expiresAt: new Date(claimed.expiresAt.getTime()),
    });
    issuedRegistrationProofs.set(proof, {
      registrationId: claimed.registrationId,
      version: claimed.version,
      emailNormalized: claimed.emailNormalized,
      nonceDigest: claimed.nonceDigest,
      expiresAtMs: claimed.expiresAt.getTime(),
    });
    return proof;
  }

  /**
   * Transaction-aware consumption primitive requiring an unforgeable
   * `VerifiedRegistrationProof` and an active `ClientSession` transaction.
   * Database CAS (`state: 'SENT' -> 'CONSUMED'`) is the durable single-use
   * authority, so aborted transactions can be safely retried with the same proof.
   */
  async consumePendingRegistration(
    proof: VerifiedRegistrationProof,
    session: ClientSession
  ): Promise<IPendingRegistration> {
    const metadata = proof ? issuedRegistrationProofs.get(proof) : undefined;
    if (!metadata) {
      throw new OtpInvalidError();
    }
    if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) {
      throw new Error(
        'Active ClientSession transaction is required for transactional registration consumption'
      );
    }

    const currentNow = this.now();
    if (metadata.expiresAtMs <= currentNow.getTime()) {
      throw new OtpInvalidError();
    }

    const consumed = await this.pendingModel
      .findOneAndUpdate(
        {
          registrationId: metadata.registrationId,
          version: metadata.version,
          nonceDigest: metadata.nonceDigest,
          state: 'SENT',
          deliveryState: 'ACCEPTED',
          otpExpiresAt: { $gt: currentNow },
          expiresAt: { $gt: currentNow },
        },
        {
          $set: { state: 'CONSUMED' },
        },
        { new: true, session }
      )
      .exec();

    if (!consumed) {
      throw new OtpInvalidError();
    }

    return consumed;
  }

  private async dispatchAndRecordDelivery(
    registrationId: string,
    version: number,
    toEmail: string,
    otpCode: string
  ): Promise<boolean> {
    let accepted = false;
    try {
      const outcome = await this.emailSender.sendOtpEmail({
        purpose: 'REGISTER_VERIFY',
        toEmail,
        otpCode,
        correlationId: registrationId,
        generation: version,
      });
      accepted = outcome.accepted;
    } catch {
      accepted = false;
    }

    await this.pendingModel
      .findOneAndUpdate(
        {
          registrationId,
          version,
          deliveryState: 'PENDING',
        },
        {
          $set: accepted
            ? { deliveryState: 'ACCEPTED', state: 'SENT' }
            : { deliveryState: 'FAILED' },
        }
      )
      .exec();

    return accepted;
  }
}
