import { randomUUID } from 'node:crypto';
import { Types, type Connection } from 'mongoose';
import type { AppConfig } from '../../../config/env.js';
import { HttpError } from '../../../core/errors.js';
import {
  getAuthIdentityModel,
  getRegistrationAllowlistModel,
  getSecurityAuditEventModel,
  getUserModel,
} from '../../identity/models/index.js';
import { runAuthTransaction } from '../transaction.js';
import { OtpInvalidError } from '../otp/types.js';
import type {
  PendingRegistrationService,
  VerifiedRegistrationProof,
} from './registration.service.js';

export interface RegistrationActivationOptions {
  connection: Connection;
  pendingRegistrationService: Pick<PendingRegistrationService, 'consumePendingRegistration'>;
  policy: Pick<AppConfig, 'POLICY_ID' | 'POLICY_CONSENT_VERSION' | 'REGISTRATION_MODE'>;
}

/**
 * The verified pending record is the sole source of the credential and email.
 * No session, JWT, identity linking or provider call belongs to this operation.
 */
export class RegistrationActivationService {
  constructor(private readonly options: RegistrationActivationOptions) {}

  async activate(proof: VerifiedRegistrationProof, requestId: string): Promise<void> {
    const { connection, pendingRegistrationService, policy } = this.options;
    const users = getUserModel(connection);
    const identities = getAuthIdentityModel(connection);
    const allowlist = getRegistrationAllowlistModel(connection);
    const audit = getSecurityAuditEventModel(connection);

    // Stable identifiers across bounded retries of the same transaction.
    const userId = new Types.ObjectId();
    const eventId = randomUUID();

    await runAuthTransaction(connection, async (session) => {
      const pending = await pendingRegistrationService.consumePendingRegistration(proof, session);
      if (pending.consentVersion !== policy.POLICY_CONSENT_VERSION) {
        throw new OtpInvalidError();
      }

      const now = new Date();
      const email = pending.emailNormalized;
      if (policy.REGISTRATION_MODE === 'INVITE_ONLY') {
        const redeemed = await allowlist.findOneAndUpdate(
          {
            emailNormalized: email,
            redeemedBy: { $exists: false },
            redeemedAt: { $exists: false },
            $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
          },
          { $set: { redeemedBy: userId, redeemedAt: now } },
          { new: true, session }
        ).exec();
        if (!redeemed) {
          throw new HttpError(409, 'STATE_CONFLICT', 'Registration is no longer eligible');
        }
      }

      // The unique canonical-email and provider/subject indexes decide races
      // with other registrations or Google provisioning. Never attach a
      // PASSWORD factor to an existing principal based only on email.
      await users.create([{
        _id: userId,
        emailNormalized: email,
        emailVerifiedAt: now,
        displayName: pending.displayName?.trim() || 'Candidate',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: pending.consentVersion,
        consentAt: now,
      }], { session });

      await identities.create([{
        userId,
        provider: 'PASSWORD',
        subject: email,
        passwordHash: pending.passwordHash,
        linkedAt: now,
        lastUsedAt: now,
      }], { session });

      await audit.create([{
        eventId,
        eventType: 'CONSENT_ACCEPTED',
        actorId: userId.toString(),
        targetId: userId.toString(),
        requestId,
        outcome: 'SUCCESS',
        at: now,
        metadata: {
          userId: userId.toString(),
          policyId: policy.POLICY_ID,
          consentVersion: pending.consentVersion,
          consentAt: now,
        },
      }], { session });
    });
  }
}
