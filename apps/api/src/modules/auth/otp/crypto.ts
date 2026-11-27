import crypto from 'node:crypto';
import type { ChallengeSubjectInput } from './types.js';

/**
 * Generates a uniform CSPRNG 6-digit OTP code, preserving leading zeros.
 */
export function generateOtpCode(): string {
  const num = crypto.randomInt(0, 1_000_000);
  return num.toString().padStart(6, '0');
}

/**
 * Computes a keyed HMAC-SHA256 digest with length-prefixed domain separation
 * so variable-length fields cannot collide across boundaries.
 */
export function computeDomainHmac(secret: string, parts: readonly string[]): string {
  if (!secret || secret.length < 16) {
    throw new Error('HMAC secret must be at least 16 characters');
  }
  const canonical = parts
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
    .join('|');
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/**
 * Computes the purpose-specific subjectDigest per P2_AUTH_API_CONTRACTS_v1.md §4.1.
 */
export function computeSubjectDigest(secret: string, input: ChallengeSubjectInput): string {
  switch (input.purpose) {
    case 'RESET_PASSWORD':
      return computeDomainHmac(secret, ['RESET_PASSWORD', input.emailNormalized]);
    case 'LINK_PASSWORD':
      return computeDomainHmac(secret, [
        'LINK_PASSWORD',
        input.userId.toHexString(),
        input.emailNormalized,
      ]);
    case 'PHONE_VERIFY':
      return computeDomainHmac(secret, [
        'PHONE_VERIFY',
        input.userId.toHexString(),
        input.phoneE164,
      ]);
  }
}

/**
 * Computes the keyed OTP digest bound to purpose, subjectDigest, id, and generation.
 */
export function computeOtpDigest(
  secret: string,
  purpose: string,
  subjectDigest: string,
  challengeOrRegId: string,
  generation: number,
  otpCode: string
): string {
  return computeDomainHmac(secret, [
    'OTP_DIGEST',
    purpose,
    subjectDigest,
    challengeOrRegId,
    String(generation),
    otpCode,
  ]);
}

/**
 * Constant-time comparison of two hex/utf8 digest strings.
 */
export function compareDigestConstantTime(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}
