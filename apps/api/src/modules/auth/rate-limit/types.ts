import type { Request } from 'express';
import { HttpError } from '../../../core/errors.js';

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
  readonly errorCode?: string;
}

export const RATE_LIMIT_POLICIES = {
  REGISTER_RESEND_EMAIL: { limit: 3, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  REGISTER_REPLACE_COOLDOWN: { limit: 1, windowMs: 60_000, errorCode: 'OTP_RATE_LIMITED' },
  REGISTER_RESEND_IP: { limit: 10, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  LOGIN_FAIL_EMAIL: { limit: 5, windowMs: 15 * 60_000, errorCode: 'AUTH_RATE_LIMITED' },
  LOGIN_IP: { limit: 30, windowMs: 15 * 60_000, errorCode: 'AUTH_RATE_LIMITED' },
  VERIFY_EMAIL_IP: { limit: 20, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  GOOGLE_EXCHANGE_UID: { limit: 10, windowMs: 15 * 60_000, errorCode: 'AUTH_RATE_LIMITED' },
  GOOGLE_EXCHANGE_IP: { limit: 30, windowMs: 15 * 60_000, errorCode: 'AUTH_RATE_LIMITED' },
  PASSWORD_FORGOT_EMAIL: { limit: 3, windowMs: 60 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  PASSWORD_FORGOT_IP: { limit: 10, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  PASSWORD_RESET_EMAIL: { limit: 5, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  PASSWORD_RESET_IP: { limit: 20, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  REAUTH_USER: { limit: 5, windowMs: 15 * 60_000, errorCode: 'AUTH_RATE_LIMITED' },
  REAUTH_IP: { limit: 20, windowMs: 15 * 60_000, errorCode: 'AUTH_RATE_LIMITED' },
  LINK_PASSWORD_USER: { limit: 3, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  LINK_PASSWORD_IP: { limit: 20, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  PHONE_START_USER: { limit: 3, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  PHONE_START_IP: { limit: 20, windowMs: 15 * 60_000, errorCode: 'OTP_RATE_LIMITED' },
  DATA_EXPORT_USER: { limit: 3, windowMs: 60 * 60_000, errorCode: 'AUTH_RATE_LIMITED' },
  DATA_EXPORT_IP: { limit: 20, windowMs: 15 * 60_000, errorCode: 'AUTH_RATE_LIMITED' },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

export class RateLimitExceededError extends HttpError {
  constructor(
    public readonly retryAfterSeconds: number,
    code = 'AUTH_RATE_LIMITED',
    message = 'Too many requests, please try again later'
  ) {
    super(429, code, message);
  }
}

/**
 * Extracts the client IP exclusively from `req.clientIp` populated by
 * the authenticated ingress middleware. Never reads caller-controlled
 * `X-Forwarded-For` headers. Falls back to `'unknown'`.
 */
export function extractTrustedClientIp(req: Pick<Request, 'clientIp'>): string {
  if (typeof req.clientIp === 'string' && req.clientIp.trim().length > 0) {
    return req.clientIp.trim();
  }
  return 'unknown';
}
