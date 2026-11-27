import type { Connection } from 'mongoose';
import type { RegisterRequest } from '@roundset/contracts';
import type { AppConfig } from '../../../config/env.js';
import { HttpError, ServiceUnavailableError } from '../../../core/errors.js';
import { getRegistrationAllowlistModel, getUserModel } from '../../identity/models/index.js';
import { OtpInvalidError } from '../otp/types.js';
import type { AuthRateLimitService } from '../rate-limit/rate-limit.service.js';
import type { RegistrationActivationService } from './activation.service.js';
import type { PendingRegistrationService } from './registration.service.js';

export interface RegistrationWorkflowOptions {
  connection: Connection;
  policy: Pick<AppConfig, 'POLICY_CONSENT_VERSION' | 'REGISTRATION_MODE'>;
  pending: PendingRegistrationService;
  activation: RegistrationActivationService;
  rateLimits: AuthRateLimitService;
  /** Must be global, not dependent on a recipient or account lookup. */
  emailAvailable: () => boolean | Promise<boolean>;
}

/**
 * Server-owned registration workflow. HTTP callers receive only the public
 * DTO plus cookie material, not internal delivery/version/identity decisions.
 * Activation rechecks admission/uniqueness within the protected transaction.
 */
export class RegistrationWorkflow {
  constructor(private readonly options: RegistrationWorkflowOptions) {}

  private assertDatabaseReady(): void {
    if (this.options.connection.readyState !== 1) {
      throw new ServiceUnavailableError('Authentication database unavailable');
    }
  }

  private async assertEmailAvailable(): Promise<void> {
    this.assertDatabaseReady();
    let available = false;
    try {
      available = await this.options.emailAvailable();
    } catch {
      // The failure is global and occurs before the recipient is looked up.
    }
    if (!available) {
      throw new HttpError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Email verification is unavailable');
    }
  }

  private async isEligible(email: string, consentVersion: string): Promise<boolean> {
    const { connection, policy } = this.options;
    if (consentVersion !== policy.POLICY_CONSENT_VERSION) return false;
    const user = await getUserModel(connection).exists({ emailNormalized: email }).exec();
    if (user) return false;
    if (policy.REGISTRATION_MODE === 'PUBLIC') return true;
    const invite = await getRegistrationAllowlistModel(connection).exists({
      emailNormalized: email,
      redeemedBy: { $exists: false },
      redeemedAt: { $exists: false },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
    }).exec();
    return Boolean(invite);
  }

  async register(input: RegisterRequest, trustedIp: string): Promise<{
    registrationId: string;
    nonce: string;
  }> {
    if (input.consentVersion !== this.options.policy.POLICY_CONSENT_VERSION) {
      throw new HttpError(400, 'CONSENT_REQUIRED', 'Current consent version is required');
    }
    await this.assertEmailAvailable();
    const result = await this.options.pending.startOrReplaceRegistration({
      emailNormalized: input.email,
      password: input.password,
      consentVersion: input.consentVersion,
      displayName: input.displayName,
      trustedIp,
    }, (email, version) => this.isEligible(email, version));
    return { registrationId: result.registrationId, nonce: result.nonce };
  }

  async resend(
    registrationId: string,
    nonce: string | undefined,
    trustedIp: string
  ): Promise<void> {
    await this.assertEmailAvailable();
    if (!nonce) {
      // Invalid cookie requests also count toward the ordinary IP cap.
      await this.options.rateLimits.consumeOrThrow('REGISTER_RESEND_IP', trustedIp);
      throw new OtpInvalidError();
    }
    await this.options.pending.resendRegistrationOtp({
      registrationId, nonce, trustedIp,
    }, (email, version) => this.isEligible(email, version));
  }

  async verify(
    registrationId: string,
    nonce: string | undefined,
    code: string,
    trustedIp: string,
    requestId: string
  ): Promise<void> {
    this.assertDatabaseReady();
    await this.options.rateLimits.consumeOrThrow('VERIFY_EMAIL_IP', trustedIp);
    if (!nonce) throw new OtpInvalidError();
    const proof = await this.options.pending.claimAndVerifyRegistrationOtp({
      registrationId, nonce, otpCode: code,
    });
    await this.options.activation.activate(proof, requestId);
  }
}
