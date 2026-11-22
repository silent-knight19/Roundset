import { z } from 'zod';
import {
  ReauthActionSchema,
} from './enums.js';
import {
  EmailNormalizedSchema,
  PasswordSchema,
  OtpCodeSchema,
  PhoneE164Schema,
  UserPreferencesSchema,
  isValidReauthActionRule,
} from './domain.js';

export const RegisterRequestSchema = z
  .object({
    email: EmailNormalizedSchema,
    password: PasswordSchema,
    displayName: z.string().min(1).max(100).optional(),
    consentVersion: z.string().min(1, 'consentVersion is required'),
  })
  .strict();
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const VerifyEmailRequestSchema = z
  .object({
    registrationId: z.string().min(1, 'registrationId is required'),
    code: OtpCodeSchema,
  })
  .strict();
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

export const ResendOtpRequestSchema = z
  .object({
    registrationId: z.string().min(1, 'registrationId is required'),
  })
  .strict();
export type ResendOtpRequest = z.infer<typeof ResendOtpRequestSchema>;

export const VerificationPasswordSchema = z
  .string()
  .min(1, 'password is required')
  .refine(
    (val) => {
      const nfc = val.normalize('NFC');
      return new TextEncoder().encode(nfc).length <= 512;
    },
    { message: 'password must not exceed 512 UTF-8 bytes' }
  )
  .transform((val) => val.normalize('NFC'));
export type VerificationPassword = z.infer<typeof VerificationPasswordSchema>;

export const LoginRequestSchema = z
  .object({
    email: EmailNormalizedSchema,
    password: VerificationPasswordSchema,
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const GoogleExchangeRequestSchema = z
  .object({
    firebaseIdToken: z.string().min(1, 'firebaseIdToken is required'),
    consentVersion: z.string().min(1).optional(),
  })
  .strict();
export type GoogleExchangeRequest = z.infer<typeof GoogleExchangeRequestSchema>;

export const PasswordForgotRequestSchema = z
  .object({
    email: EmailNormalizedSchema,
  })
  .strict();
export type PasswordForgotRequest = z.infer<typeof PasswordForgotRequestSchema>;

export const PasswordResetRequestSchema = z
  .object({
    email: EmailNormalizedSchema,
    code: OtpCodeSchema,
    newPassword: PasswordSchema,
  })
  .strict();
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

const PasswordReauthSchema = z
  .object({
    action: ReauthActionSchema,
    target: z.string().nullable().optional(),
    method: z.literal('PASSWORD'),
    password: VerificationPasswordSchema,
  })
  .strict();

const GoogleReauthSchema = z
  .object({
    action: ReauthActionSchema,
    target: z.string().nullable().optional(),
    method: z.literal('FIREBASE_GOOGLE'),
    firebaseIdToken: z.string().min(1, 'firebaseIdToken is required'),
  })
  .strict();

export const ReauthRequestSchema = z
  .discriminatedUnion('method', [PasswordReauthSchema, GoogleReauthSchema])
  .superRefine((data, ctx) => {
    if (!isValidReauthActionRule(data.action, data.target, data.method)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Forbidden reauthentication rule: action=${data.action}, target=${data.target ?? 'null'}, method=${data.method}`,
        path: ['action'],
      });
    }
  });
export type ReauthRequest = z.infer<typeof ReauthRequestSchema>;

export const PasswordChangeRequestSchema = z
  .object({
    newPassword: PasswordSchema,
    reauthTicket: z.string().min(1, 'reauthTicket is required'),
  })
  .strict();
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>;

export const LinkGoogleRequestSchema = z
  .object({
    firebaseIdToken: z.string().min(1, 'firebaseIdToken is required'),
    reauthTicket: z.string().min(1, 'reauthTicket is required'),
  })
  .strict();
export type LinkGoogleRequest = z.infer<typeof LinkGoogleRequestSchema>;

export const LinkPasswordStartRequestSchema = z
  .object({
    reauthTicket: z.string().min(1, 'reauthTicket is required'),
  })
  .strict();
export type LinkPasswordStartRequest = z.infer<typeof LinkPasswordStartRequestSchema>;

export const LinkPasswordRequestSchema = z
  .object({
    newPassword: PasswordSchema,
    emailCode: OtpCodeSchema,
    reauthTicket: z.string().min(1, 'reauthTicket is required'),
  })
  .strict();
export type LinkPasswordRequest = z.infer<typeof LinkPasswordRequestSchema>;

export const UnlinkIdentityRequestSchema = z
  .object({
    reauthTicket: z.string().min(1, 'reauthTicket is required'),
  })
  .strict();
export type UnlinkIdentityRequest = z.infer<typeof UnlinkIdentityRequestSchema>;

export const RevokeSessionRequestSchema = z
  .object({
    reauthTicket: z.string().min(1).optional(),
  })
  .strict();
export type RevokeSessionRequest = z.infer<typeof RevokeSessionRequestSchema>;

export const PhoneStartRequestSchema = z
  .object({
    phoneE164: PhoneE164Schema,
  })
  .strict();
export type PhoneStartRequest = z.infer<typeof PhoneStartRequestSchema>;

export const PhoneVerifyRequestSchema = z
  .object({
    phoneE164: PhoneE164Schema,
    code: OtpCodeSchema,
  })
  .strict();
export type PhoneVerifyRequest = z.infer<typeof PhoneVerifyRequestSchema>;

export const PatchMeRequestSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    preferences: UserPreferencesSchema.optional(),
  })
  .strict();
export type PatchMeRequest = z.infer<typeof PatchMeRequestSchema>;

export const PostConsentRequestSchema = z
  .object({
    consentVersion: z.string().min(1, 'consentVersion is required'),
  })
  .strict();
export type PostConsentRequest = z.infer<typeof PostConsentRequestSchema>;

export const DeleteAccountRequestSchema = z
  .object({
    reauthTicket: z.string().min(1, 'reauthTicket is required'),
    confirmation: z.literal('DELETE MY ACCOUNT'),
  })
  .strict();
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;
