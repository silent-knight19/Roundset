import crypto from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
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
   * Enforces IP cap, combined email budget, and 60s replacement cooldown BEFORE
   * touching pendingRegistrations so rejected requests never overwrite existing state.
   */
  async startOrReplaceRegistration(
    input: StartRegistrationInput
  ): Promise<StartRegistrationResult> {
    // 1. Durable rate limits & cooldown (independent of pendingRegistrations)
    await this.rateLimitService.consumeOrThrow('REGISTER_RESEND_IP', input.trustedIp);
    await this.rateLimitService.consumeOrThrow(
      'REGISTER_REPLACE_COOLDOWN',
      input.emailNormalized
    );
    await this.rateLimitService.consumeOrThrow(
      'REGISTER_RESEND_EMAIL',
      input.emailNormalized
    );

    // 2. Hash password with bounded Argon2id service
    const passwordHash = await this.passwordService.hashPassword(input.password);

    // 3. Generate CSPRNG registrationId (>=128 bits), nonce (>=256 bits), and 6-digit OTP
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

    // 4. Atomic upsert/replacement by canonical email
    let version = 1;
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
          break;
        } catch (err: unknown) {
          const code = (err as { code?: number })?.code;
          if (code === 11000) {
            continue;
          }
          throw err;
        }
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
        break;
      }
    }

    // 5. Send OTP outside any DB transaction, then CAS-update deliveryState
    const sendOutcome = await this.emailSender.sendOtpEmail({
      purpose: 'REGISTER_VERIFY',
      toEmail: input.emailNormalized,
      otpCode,
      correlationId: registrationId,
      generation: version,
    });

    await this.pendingModel
      .findOneAndUpdate(
        {
          registrationId,
          version,
          deliveryState: 'PENDING',
        },
        {
          $set: sendOutcome.accepted
            ? { deliveryState: 'ACCEPTED', state: 'SENT' }
            : { deliveryState: 'FAILED' },
        }
      )
      .exec();

    return {
      registrationId,
      nonce,
      version,
      deliveryAccepted: sendOutcome.accepted,
      expiresAt,
      otpExpiresAt,
    };
  }

  /**
   * Atomically claims 1 of 5 OTP attempt slots BEFORE comparing the OTP digest.
   * Validates browser-bound nonce digest, accepted delivery, SENT state, and expiry.
   */
  async claimAndVerifyRegistrationOtp(params: {
    registrationId: string;
    nonce: string;
    otpCode: string;
  }): Promise<{ registrationId: string; version: number; emailNormalized: string }> {
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

    return {
      registrationId: claimed.registrationId,
      version: claimed.version,
      emailNormalized: claimed.emailNormalized,
    };
  }

  /**
   * Transaction-aware consumption primitive for pending registration.
   */
  async consumePendingRegistration(
    registrationId: string,
    version: number,
    session: ClientSession
  ): Promise<IPendingRegistration> {
    if (!session) {
      throw new Error('ClientSession is required for transactional registration consumption');
    }

    const currentNow = this.now();
    const consumed = await this.pendingModel
      .findOneAndUpdate(
        {
          registrationId,
          version,
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
}
