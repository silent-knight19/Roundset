import type { Types } from 'mongoose';
import { HttpError } from '../../../core/errors.js';

export type OtpPurpose = 'RESET_PASSWORD' | 'LINK_PASSWORD' | 'PHONE_VERIFY';

export const OTP_POLICY = {
  digits: 6,
  ttlMs: 5 * 60 * 1000,
  maxAttempts: 5,
} as const;

export type ChallengeSubjectInput =
  | {
      purpose: 'RESET_PASSWORD';
      emailNormalized: string;
      userId: Types.ObjectId;
      passwordIdentityIdAtIssue: Types.ObjectId;
      identityVersionAtIssue: number;
    }
  | {
      purpose: 'LINK_PASSWORD';
      emailNormalized: string;
      userId: Types.ObjectId;
      sessionId: string;
      reauthTicketDigest: string;
    }
  | {
      purpose: 'PHONE_VERIFY';
      phoneE164: string;
      userId: Types.ObjectId;
    };

export interface IssuedChallengeResult {
  challengeId: string;
  purpose: OtpPurpose;
  subjectDigest: string;
  generation: number;
  expiresAt: Date;
  otpCode: string;
}

export class OtpInvalidError extends HttpError {
  constructor(message = 'Invalid or expired verification code') {
    super(400, 'OTP_INVALID', message);
  }
}

export class OtpExpiredError extends HttpError {
  constructor(message = 'Verification code has expired') {
    super(400, 'OTP_EXPIRED', message);
  }
}
