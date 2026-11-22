import { z } from 'zod';
import { ResponseMetaSchema } from '../common.js';
import {
  UserRoleSchema,
  AccountStatusSchema,
  AuthProviderSchema,
  RegistrationModeSchema,
} from './enums.js';
import {
  ConsentHistoryItemSchema,
  UserIdentityProfileSchema,
} from './domain.js';

export const AuthMetaResponseDataSchema = z
  .object({
    activePolicyId: z.string().min(1),
    activeConsentVersion: z.string().min(1),
    registrationMode: RegistrationModeSchema,
  })
  .strict();
export type AuthMetaResponseData = z.infer<typeof AuthMetaResponseDataSchema>;

export const AuthMetaResponseSchema = z.object({
  data: AuthMetaResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type AuthMetaResponse = z.infer<typeof AuthMetaResponseSchema>;

export const RegisterResponseDataSchema = z
  .object({
    registrationId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type RegisterResponseData = z.infer<typeof RegisterResponseDataSchema>;

export const RegisterResponseSchema = z.object({
  data: RegisterResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const GenericMessageResponseDataSchema = z
  .object({
    message: z.string().min(1),
  })
  .strict();
export type GenericMessageResponseData = z.infer<typeof GenericMessageResponseDataSchema>;

export const GenericMessageResponseSchema = z.object({
  data: GenericMessageResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type GenericMessageResponse = z.infer<typeof GenericMessageResponseSchema>;

export const AuthUserDtoSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().email(),
    emailVerified: z.boolean(),
    displayName: z.string().min(1).max(100),
    role: UserRoleSchema,
    accountStatus: AccountStatusSchema,
  })
  .strict();
export type AuthUserDto = z.infer<typeof AuthUserDtoSchema>;

export const AuthSessionDtoSchema = z
  .object({
    id: z.string().min(1),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type AuthSessionDto = z.infer<typeof AuthSessionDtoSchema>;

export const SessionDataSchema = z
  .object({
    accessToken: z.string().min(1),
    tokenType: z.literal('Bearer'),
    expiresInSeconds: z.number().int().positive(),
    user: AuthUserDtoSchema,
    session: AuthSessionDtoSchema,
  })
  .strict();
export type SessionData = z.infer<typeof SessionDataSchema>;

export const SessionResponseSchema = z.object({
  data: SessionDataSchema,
  meta: ResponseMetaSchema,
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const ReauthResponseDataSchema = z
  .object({
    reauthTicket: z.string().min(1),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ReauthResponseData = z.infer<typeof ReauthResponseDataSchema>;

export const ReauthResponseSchema = z.object({
  data: ReauthResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type ReauthResponse = z.infer<typeof ReauthResponseSchema>;

export const LinkIdentityResponseDataSchema = z
  .object({
    provider: AuthProviderSchema,
    linkedAt: z.string().datetime(),
  })
  .strict();
export type LinkIdentityResponseData = z.infer<typeof LinkIdentityResponseDataSchema>;

export const LinkIdentityResponseSchema = z.object({
  data: LinkIdentityResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type LinkIdentityResponse = z.infer<typeof LinkIdentityResponseSchema>;

export const PhoneVerifyResponseDataSchema = z
  .object({
    phoneE164: z.string().min(1),
    phoneVerifiedAt: z.string().datetime(),
  })
  .strict();
export type PhoneVerifyResponseData = z.infer<typeof PhoneVerifyResponseDataSchema>;

export const PhoneVerifyResponseSchema = z.object({
  data: PhoneVerifyResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type PhoneVerifyResponse = z.infer<typeof PhoneVerifyResponseSchema>;

export const SessionListItemSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().datetime(),
    lastUsedAt: z.string().datetime(),
    isCurrent: z.boolean(),
    approxDeviceLabel: z.string().optional(),
  })
  .strict();
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

export const GetSessionsResponseDataSchema = z
  .object({
    sessions: z.array(SessionListItemSchema),
  })
  .strict();
export type GetSessionsResponseData = z.infer<typeof GetSessionsResponseDataSchema>;

export const GetSessionsResponseSchema = z.object({
  data: GetSessionsResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type GetSessionsResponse = z.infer<typeof GetSessionsResponseSchema>;

export const GetMeResponseSchema = z.object({
  data: UserIdentityProfileSchema,
  meta: ResponseMetaSchema,
});
export type GetMeResponse = z.infer<typeof GetMeResponseSchema>;

export const PostConsentResponseDataSchema = z
  .object({
    consentVersion: z.string().min(1),
    consentAt: z.string().datetime(),
  })
  .strict();
export type PostConsentResponseData = z.infer<typeof PostConsentResponseDataSchema>;

export const PostConsentResponseSchema = z.object({
  data: PostConsentResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type PostConsentResponse = z.infer<typeof PostConsentResponseSchema>;

export const DataExportResponseDataSchema = z
  .object({
    identityProfile: UserIdentityProfileSchema,
    linkedProviderTypes: z.array(AuthProviderSchema),
    consentHistory: z.array(ConsentHistoryItemSchema),
    accountStatus: AccountStatusSchema,
    exportedAt: z.string().datetime(),
  })
  .strict();
export type DataExportResponseData = z.infer<typeof DataExportResponseDataSchema>;

export const DataExportResponseSchema = z.object({
  data: DataExportResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type DataExportResponse = z.infer<typeof DataExportResponseSchema>;

export const DeleteAccountResponseDataSchema = z
  .object({
    status: z.literal('PENDING_DELETION'),
    requestedAt: z.string().datetime(),
  })
  .strict();
export type DeleteAccountResponseData = z.infer<typeof DeleteAccountResponseDataSchema>;

export const DeleteAccountResponseSchema = z.object({
  data: DeleteAccountResponseDataSchema,
  meta: ResponseMetaSchema,
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;
