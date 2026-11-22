import { z } from 'zod';
import {
  UserRoleSchema,
  AccountStatusSchema,
  AuthProviderSchema,
  ReauthAction,
  ReauthMethod,
} from './enums.js';

/**
 * Checks if a string contains ASCII control characters (0x00-0x1F, 0x7F).
 * Avoids control characters in regular expressions to adhere to lint standards.
 */
export function hasControlCharacters(val: string): boolean {
  for (let i = 0; i < val.length; i++) {
    const code = val.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes email according to Phase 2 auth.v1 specifications (§3.2, §4.3):
 * - Trim boundary whitespace
 * - Reject CR/LF/control characters and non-ASCII email characters
 * - Lowercase for case-insensitive lookup
 * - Retain Gmail dots and +tag (never strip)
 * - Length between 3 and 254 characters
 */
export function normalizeEmail(email: string): string {
  if (typeof email !== 'string') {
    throw new Error('Email must be a string');
  }
  // Reject forbidden CR/LF/control characters on raw input before boundary trimming
  if (hasControlCharacters(email)) {
    throw new Error('Email contains illegal control characters');
  }
  const trimmed = email.trim();
  if (trimmed.length === 0) {
    throw new Error('Email must not be empty');
  }
  if (trimmed.length > 254) {
    throw new Error('Email must not exceed 254 characters');
  }
  if (!/^[\x20-\x7E]+$/.test(trimmed)) {
    throw new Error('Email contains non-ASCII characters');
  }
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf('@') || atIndex === trimmed.length - 1) {
    throw new Error('Email format is invalid');
  }
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  if (!domain.includes('.')) {
    throw new Error('Email domain must contain a dot');
  }
  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}

export const EmailNormalizedSchema = z
  .string()
  .min(3, 'Email must be at least 3 characters')
  .max(254, 'Email must not exceed 254 characters')
  .refine((val) => !hasControlCharacters(val), {
    message: 'Email contains illegal control characters',
  })
  .refine((val) => /^[\x20-\x7E]+$/.test(val), {
    message: 'Email must contain only ASCII characters',
  })
  .refine(
    (val) => {
      const trimmed = val.trim();
      const at = trimmed.indexOf('@');
      return at > 0 && at === trimmed.lastIndexOf('@') && at < trimmed.length - 1 && trimmed.slice(at + 1).includes('.');
    },
    { message: 'Email format is invalid' }
  )
  .transform((val) => {
    const trimmed = val.trim();
    const at = trimmed.indexOf('@');
    return `${trimmed.slice(0, at).toLowerCase()}@${trimmed.slice(at + 1).toLowerCase()}`;
  });

/**
 * Validates password according to Phase 2 auth.v1 specifications (§4.3):
 * - 12 to 128 Unicode code points
 * - Max 512 UTF-8 bytes
 * - Reject NUL / control characters
 * - Normalized to Unicode NFC
 */
export const PasswordSchema = z
  .string()
  .refine((val) => !hasControlCharacters(val), {
    message: 'Password contains illegal control characters',
  })
  .refine(
    (val) => {
      const nfc = val.normalize('NFC');
      const length = [...nfc].length;
      return length >= 12 && length <= 128;
    },
    { message: 'Password must be between 12 and 128 Unicode code points' }
  )
  .refine(
    (val) => {
      const nfc = val.normalize('NFC');
      const bytes = new TextEncoder().encode(nfc).length;
      return bytes <= 512;
    },
    { message: 'Password must not exceed 512 UTF-8 bytes' }
  )
  .transform((val) => val.normalize('NFC'));

export const OtpCodeSchema = z
  .string()
  .regex(/^\d{6}$/, 'OTP code must be exactly 6 decimal digits');

export const PhoneE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'Phone number must be in E.164 format (e.g. +1234567890)');

export const UserPreferencesSchema = z
  .object({
    language: z.literal('en').optional(),
    reducedMotion: z.boolean().optional(),
    timezone: z
      .string()
      .max(64, 'Timezone must not exceed 64 characters')
      .refine(
        (tz) => {
          try {
            Intl.DateTimeFormat(undefined, { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        },
        { message: 'Invalid IANA timezone identifier' }
      )
      .optional(),
  })
  .strict();
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/**
 * Closed reauthentication rule validation according to Table §3.4
 */
export function isValidReauthActionRule(
  action: ReauthAction,
  target: string | null | undefined,
  methodUsed: ReauthMethod
): boolean {
  switch (action) {
    case 'CHANGE_PASSWORD':
      return (target === null || target === undefined) && methodUsed === 'PASSWORD';
    case 'LINK_GOOGLE':
      return (target === null || target === undefined) && methodUsed === 'PASSWORD';
    case 'LINK_PASSWORD':
      return (target === null || target === undefined) && methodUsed === 'FIREBASE_GOOGLE';
    case 'UNLINK_IDENTITY':
      if (target === 'PASSWORD' && methodUsed === 'FIREBASE_GOOGLE') return true;
      if (target === 'FIREBASE_GOOGLE' && methodUsed === 'PASSWORD') return true;
      return false;
    case 'REVOKE_OTHER_SESSION':
      return (
        typeof target === 'string' &&
        target.length > 0 &&
        (methodUsed === 'PASSWORD' || methodUsed === 'FIREBASE_GOOGLE')
      );
    case 'DELETE_ACCOUNT':
      return (target === null || target === undefined) && (methodUsed === 'PASSWORD' || methodUsed === 'FIREBASE_GOOGLE');
    default:
      return false;
  }
}

export const ConsentHistoryItemSchema = z
  .object({
    eventId: z.string().min(1),
    userId: z.string().min(1),
    policyId: z.string().min(1),
    consentVersion: z.string().min(1),
    consentAt: z.string().datetime(),
  })
  .strict();
export type ConsentHistoryItem = z.infer<typeof ConsentHistoryItemSchema>;

export const ConsentAuditEventMetadataSchema = z
  .object({
    userId: z.string().min(1),
    policyId: z.string().min(1),
    consentVersion: z.string().min(1),
    consentAt: z.union([z.string().datetime(), z.date()]),
  })
  .passthrough();
export type ConsentAuditEventMetadata = z.infer<typeof ConsentAuditEventMetadataSchema>;

export const UserIdentityProfileSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().email(),
    emailVerified: z.boolean(),
    displayName: z.string().min(1).max(100),
    role: UserRoleSchema,
    accountStatus: AccountStatusSchema,
    linkedProviders: z.array(AuthProviderSchema),
    consentVersion: z.string().min(1),
    preferences: UserPreferencesSchema,
    phoneVerifiedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime().optional(),
  })
  .strict();
export type UserIdentityProfile = z.infer<typeof UserIdentityProfileSchema>;
