import crypto from 'node:crypto';
import { computeDomainHmac } from '../otp/crypto.js';

// Fixed 96-byte authenticated envelope: IV (12), tag (16), ciphertext
// (32 random bytes, 32-byte keyed email subject, 4-byte expiry in seconds).
// Base64url encoding is exactly 128 characters, within the existing cookie bound.
// No plaintext email or eligibility bit is encoded.
const RECEIPT_BYTES = 96;
const NONCE_LENGTH = 128;

export function registrationRateSubject(secret: string, email: string): string {
  return computeDomainHmac(secret, ['REGISTRATION_RATE_SUBJECT', email]);
}

function receiptKey(secret: string): Buffer {
  return Buffer.from(computeDomainHmac(secret, ['REGISTRATION_RECEIPT_KEY_V1']), 'hex');
}

function aad(registrationId: string): Buffer {
  return Buffer.from('roundset-registration-receipt-v1:' + registrationId, 'utf8');
}

export function createRegistrationReceipt(
  secret: string, registrationId: string, subject: string, expiresAt: Date
): string {
  const payload = Buffer.alloc(68);
  crypto.randomBytes(32).copy(payload, 0);
  Buffer.from(subject, 'hex').copy(payload, 32);
  payload.writeUInt32BE(Math.floor(expiresAt.getTime() / 1000), 64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', receiptKey(secret), iv);
  cipher.setAAD(aad(registrationId));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function readRegistrationReceipt(
  secret: string, registrationId: string, nonce: string, now: Date
): { subject: string; expiresAt: Date } | null {
  if (!/^[a-f0-9]{32}$/.test(registrationId) || nonce.length !== NONCE_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(nonce)) return null;
  try {
    const raw = Buffer.from(nonce, 'base64url');
    if (raw.length !== RECEIPT_BYTES || raw.toString('base64url') !== nonce) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', receiptKey(secret), raw.subarray(0, 12));
    decipher.setAAD(aad(registrationId));
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    const expiresAt = new Date(payload.readUInt32BE(64) * 1000);
    if (expiresAt <= now) return null;
    return { subject: payload.subarray(32, 64).toString('hex'), expiresAt };
  } catch {
    return null;
  }
}
