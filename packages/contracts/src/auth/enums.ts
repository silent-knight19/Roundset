import { z } from 'zod';

export const UserRoleSchema = z.enum(['CANDIDATE', 'ADMIN']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const AccountStatusSchema = z.enum([
  'ACTIVE',
  'SUSPENDED',
  'PENDING_DELETION',
  'DELETED',
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AuthProviderSchema = z.enum(['PASSWORD', 'FIREBASE_GOOGLE']);
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const SessionStatusSchema = z.enum([
  'ACTIVE',
  'REVOKED',
  'COMPROMISED',
  'EXPIRED',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ChallengePurposeSchema = z.enum([
  'RESET_PASSWORD',
  'LINK_PASSWORD',
  'PHONE_VERIFY',
]);
export type ChallengePurpose = z.infer<typeof ChallengePurposeSchema>;

export const ChallengeStateSchema = z.enum([
  'ISSUED',
  'CONSUMED',
  'INVALIDATED',
]);
export type ChallengeState = z.infer<typeof ChallengeStateSchema>;

export const DeliveryStateSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'FAILED',
]);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export const PendingRegistrationStateSchema = z.enum([
  'PENDING_DELIVERY',
  'SENT',
  'CONSUMED',
]);
export type PendingRegistrationState = z.infer<typeof PendingRegistrationStateSchema>;

export const ReauthActionSchema = z.enum([
  'CHANGE_PASSWORD',
  'LINK_GOOGLE',
  'LINK_PASSWORD',
  'UNLINK_IDENTITY',
  'REVOKE_OTHER_SESSION',
  'DELETE_ACCOUNT',
]);
export type ReauthAction = z.infer<typeof ReauthActionSchema>;

export const ReauthMethodSchema = z.enum(['PASSWORD', 'FIREBASE_GOOGLE']);
export type ReauthMethod = z.infer<typeof ReauthMethodSchema>;

export const RegistrationModeSchema = z.enum(['PUBLIC', 'INVITE_ONLY']);
export type RegistrationMode = z.infer<typeof RegistrationModeSchema>;

export const AuthErrorCodeSchema = z.enum([
  'CONSENT_REQUIRED',
  'INVALID_INPUT',
  'OTP_INVALID',
  'AUTH_REQUIRED',
  'INVALID_CREDENTIALS',
  'SESSION_REPLAY_DETECTED',
  'EMAIL_UNVERIFIED',
  'ACCOUNT_SUSPENDED',
  'REAUTH_REQUIRED',
  'FORBIDDEN',
  'REGISTRATION_RESTRICTED',
  'IDENTITY_LINK_REQUIRED',
  'IDENTITY_ALREADY_LINKED',
  'STATE_CONFLICT',
  'OTP_RATE_LIMITED',
  'AUTH_RATE_LIMITED',
  'AUTH_PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;
