import { describe, it, expect } from 'vitest';
import {
  UserRoleSchema,
  AccountStatusSchema,
  AuthProviderSchema,
  SessionStatusSchema,
  ChallengePurposeSchema,
  ChallengeStateSchema,
  DeliveryStateSchema,
  PendingRegistrationStateSchema,
  ReauthActionSchema,
  ReauthMethodSchema,
  RegistrationModeSchema,
  AuthErrorCodeSchema,
  normalizeEmail,
  EmailNormalizedSchema,
  PasswordSchema,
  OtpCodeSchema,
  PhoneE164Schema,
  UserPreferencesSchema,
  isValidReauthActionRule,
  ConsentHistoryItemSchema,
  ConsentAuditEventMetadataSchema,
  RegisterRequestSchema,
  VerifyEmailRequestSchema,
  ResendOtpRequestSchema,
  LoginRequestSchema,
  GoogleExchangeRequestSchema,
  PasswordForgotRequestSchema,
  PasswordResetRequestSchema,
  ReauthRequestSchema,
  PasswordChangeRequestSchema,
  LinkGoogleRequestSchema,
  LinkPasswordStartRequestSchema,
  LinkPasswordRequestSchema,
  UnlinkIdentityRequestSchema,
  RevokeSessionRequestSchema,
  PhoneStartRequestSchema,
  PhoneVerifyRequestSchema,
  PatchMeRequestSchema,
  PostConsentRequestSchema,
  DeleteAccountRequestSchema,
  SessionResponseSchema,
  AuthUserDtoSchema,
  GetMeResponseSchema,
  DataExportResponseSchema,
  AuthMetaResponseSchema,
} from '../src/index.js';

describe('Phase 2 Auth Shared Contracts', () => {
  describe('Enums and Invariants', () => {
    it('validates UserRole enum and rejects unauthorized roles', () => {
      expect(UserRoleSchema.safeParse('CANDIDATE').success).toBe(true);
      expect(UserRoleSchema.safeParse('ADMIN').success).toBe(true);
      expect(UserRoleSchema.safeParse('SUPERADMIN').success).toBe(false);
      expect(UserRoleSchema.safeParse('GUEST').success).toBe(false);
      expect(UserRoleSchema.safeParse('').success).toBe(false);
    });

    it('validates AccountStatus enum and strictly rejects PENDING_EMAIL', () => {
      expect(AccountStatusSchema.safeParse('ACTIVE').success).toBe(true);
      expect(AccountStatusSchema.safeParse('SUSPENDED').success).toBe(true);
      expect(AccountStatusSchema.safeParse('PENDING_DELETION').success).toBe(true);
      expect(AccountStatusSchema.safeParse('DELETED').success).toBe(true);

      // Critical invariant: NO PENDING_EMAIL user account
      expect(AccountStatusSchema.safeParse('PENDING_EMAIL').success).toBe(false);
      expect(AccountStatusSchema.safeParse('UNVERIFIED').success).toBe(false);
    });

    it('validates AuthProvider enum', () => {
      expect(AuthProviderSchema.safeParse('PASSWORD').success).toBe(true);
      expect(AuthProviderSchema.safeParse('FIREBASE_GOOGLE').success).toBe(true);
      expect(AuthProviderSchema.safeParse('GITHUB').success).toBe(false);
      expect(AuthProviderSchema.safeParse('OTP_ONLY').success).toBe(false);
    });

    it('validates SessionStatus enum', () => {
      expect(SessionStatusSchema.safeParse('ACTIVE').success).toBe(true);
      expect(SessionStatusSchema.safeParse('REVOKED').success).toBe(true);
      expect(SessionStatusSchema.safeParse('COMPROMISED').success).toBe(true);
      expect(SessionStatusSchema.safeParse('EXPIRED').success).toBe(true);
      expect(SessionStatusSchema.safeParse('IDLE').success).toBe(false);
    });

    it('validates ChallengePurpose, ChallengeState, DeliveryState, and PendingRegistrationState', () => {
      expect(ChallengePurposeSchema.safeParse('RESET_PASSWORD').success).toBe(true);
      expect(ChallengePurposeSchema.safeParse('LINK_PASSWORD').success).toBe(true);
      expect(ChallengePurposeSchema.safeParse('PHONE_VERIFY').success).toBe(true);
      expect(ChallengePurposeSchema.safeParse('LOGIN_OTP').success).toBe(false);

      expect(ChallengeStateSchema.safeParse('ISSUED').success).toBe(true);
      expect(ChallengeStateSchema.safeParse('CONSUMED').success).toBe(true);
      expect(ChallengeStateSchema.safeParse('INVALIDATED').success).toBe(true);

      expect(DeliveryStateSchema.safeParse('PENDING').success).toBe(true);
      expect(DeliveryStateSchema.safeParse('ACCEPTED').success).toBe(true);
      expect(DeliveryStateSchema.safeParse('FAILED').success).toBe(true);

      expect(PendingRegistrationStateSchema.safeParse('PENDING_DELIVERY').success).toBe(true);
      expect(PendingRegistrationStateSchema.safeParse('SENT').success).toBe(true);
      expect(PendingRegistrationStateSchema.safeParse('CONSUMED').success).toBe(true);
    });

    it('validates ReauthAction, ReauthMethod, and RegistrationMode', () => {
      expect(ReauthActionSchema.safeParse('CHANGE_PASSWORD').success).toBe(true);
      expect(ReauthActionSchema.safeParse('LINK_GOOGLE').success).toBe(true);
      expect(ReauthActionSchema.safeParse('LINK_PASSWORD').success).toBe(true);
      expect(ReauthActionSchema.safeParse('UNLINK_IDENTITY').success).toBe(true);
      expect(ReauthActionSchema.safeParse('REVOKE_OTHER_SESSION').success).toBe(true);
      expect(ReauthActionSchema.safeParse('DELETE_ACCOUNT').success).toBe(true);

      expect(ReauthMethodSchema.safeParse('PASSWORD').success).toBe(true);
      expect(ReauthMethodSchema.safeParse('FIREBASE_GOOGLE').success).toBe(true);
      expect(ReauthMethodSchema.safeParse('SMS').success).toBe(false);

      expect(RegistrationModeSchema.safeParse('PUBLIC').success).toBe(true);
      expect(RegistrationModeSchema.safeParse('INVITE_ONLY').success).toBe(true);
      expect(RegistrationModeSchema.safeParse('CLOSED').success).toBe(false);
    });

    it('validates all canonical AuthErrorCode values', () => {
      const validCodes = [
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
      ];
      for (const code of validCodes) {
        expect(AuthErrorCodeSchema.safeParse(code).success).toBe(true);
      }
      expect(AuthErrorCodeSchema.safeParse('OTP_EXPIRED').success).toBe(false);
    });
  });

  describe('Domain Rules & Sanitization', () => {
    it('normalizes email: lowercases, trims, preserves Gmail dots and +tags, rejects non-ASCII and controls', () => {
      expect(normalizeEmail('  Candidate.Name+Tag@Example.Com  ')).toBe('candidate.name+tag@example.com');
      expect(EmailNormalizedSchema.parse('  Candidate.Name+Tag@Example.Com  ')).toBe(
        'candidate.name+tag@example.com'
      );

      // Rejects control characters anywhere, including trailing and leading positions before trimming
      expect(() => normalizeEmail('bad\nemail@example.com')).toThrow(/illegal control characters/);
      expect(() => normalizeEmail('bad\remail@example.com')).toThrow(/illegal control characters/);
      expect(() => normalizeEmail('bad\x00email@example.com')).toThrow(/illegal control characters/);
      expect(() => normalizeEmail('test@example.com\n')).toThrow(/illegal control characters/);
      expect(() => normalizeEmail('test@example.com\r')).toThrow(/illegal control characters/);
      expect(() => normalizeEmail('test@example.com\t')).toThrow(/illegal control characters/);
      expect(() => normalizeEmail('\ntest@example.com')).toThrow(/illegal control characters/);
      expect(() => normalizeEmail('test@example.com\r\n')).toThrow(/illegal control characters/);
      expect(EmailNormalizedSchema.safeParse('test@example.com\n').success).toBe(false);
      expect(EmailNormalizedSchema.safeParse('test@example.com\r').success).toBe(false);
      expect(EmailNormalizedSchema.safeParse('test@example.com\t').success).toBe(false);
      expect(EmailNormalizedSchema.safeParse('bad\nemail@example.com').success).toBe(false);

      // Rejects non-ASCII
      expect(() => normalizeEmail('münchen@example.com')).toThrow();
      expect(EmailNormalizedSchema.safeParse('münchen@example.com').success).toBe(false);

      // Rejects invalid structure
      expect(EmailNormalizedSchema.safeParse('no-at-sign.com').success).toBe(false);
      expect(EmailNormalizedSchema.safeParse('@no-local.com').success).toBe(false);
      expect(EmailNormalizedSchema.safeParse('no-domain-dot@com').success).toBe(false);
    });

    it('validates password policy: 12-128 Unicode code points, NFC, max 512 bytes, no controls', () => {
      // Valid password (12 code points)
      expect(PasswordSchema.safeParse('CorrectHorse!').success).toBe(true);

      // Too short (<12)
      expect(PasswordSchema.safeParse('Short1!').success).toBe(false);

      // Control character rejected
      expect(PasswordSchema.safeParse('Password123!\x00').success).toBe(false);
      expect(PasswordSchema.safeParse('Password123!\n').success).toBe(false);

      // Unicode NFC normalization
      const decomposed = 'Caf\u0065\u030112345678!'; // "Café12345678!" in NFD
      const parsed = PasswordSchema.parse(decomposed);
      expect(parsed).toBe('Caf\u00E912345678!'); // normalized to NFC
    });

    it('validates OTP codes: strictly 6 decimal digits', () => {
      expect(OtpCodeSchema.safeParse('123456').success).toBe(true);
      expect(OtpCodeSchema.safeParse('000000').success).toBe(true);
      expect(OtpCodeSchema.safeParse('12345').success).toBe(false);
      expect(OtpCodeSchema.safeParse('1234567').success).toBe(false);
      expect(OtpCodeSchema.safeParse('12345a').success).toBe(false);
      expect(OtpCodeSchema.safeParse(' 123456').success).toBe(false);
    });

    it('validates Phone numbers in E.164 format', () => {
      expect(PhoneE164Schema.safeParse('+14155552671').success).toBe(true);
      expect(PhoneE164Schema.safeParse('+919876543210').success).toBe(true);
      expect(PhoneE164Schema.safeParse('14155552671').success).toBe(false);
      expect(PhoneE164Schema.safeParse('+0123456').success).toBe(false);
      expect(PhoneE164Schema.safeParse('not-a-phone').success).toBe(false);
    });

    it('validates UserPreferences with strict schema and IANA timezone validation', () => {
      expect(
        UserPreferencesSchema.safeParse({
          language: 'en',
          reducedMotion: true,
          timezone: 'Asia/Kolkata',
        }).success
      ).toBe(true);

      // Rejects unknown language
      expect(
        UserPreferencesSchema.safeParse({
          language: 'fr',
        }).success
      ).toBe(false);

      // Rejects invalid IANA timezone
      expect(
        UserPreferencesSchema.safeParse({
          timezone: 'Invalid/NonExistent_Zone',
        }).success
      ).toBe(false);

      // Rejects extra properties
      expect(
        UserPreferencesSchema.safeParse({
          language: 'en',
          extraProperty: true,
        }).success
      ).toBe(false);
    });

    it('enforces the closed Reauthentication action/target/method matrix (Table §3.4)', () => {
      // CHANGE_PASSWORD: target null, method PASSWORD
      expect(isValidReauthActionRule('CHANGE_PASSWORD', null, 'PASSWORD')).toBe(true);
      expect(isValidReauthActionRule('CHANGE_PASSWORD', undefined, 'PASSWORD')).toBe(true);
      expect(isValidReauthActionRule('CHANGE_PASSWORD', null, 'FIREBASE_GOOGLE')).toBe(false);
      expect(isValidReauthActionRule('CHANGE_PASSWORD', 'target', 'PASSWORD')).toBe(false);

      // LINK_GOOGLE: target null, method PASSWORD
      expect(isValidReauthActionRule('LINK_GOOGLE', null, 'PASSWORD')).toBe(true);
      expect(isValidReauthActionRule('LINK_GOOGLE', null, 'FIREBASE_GOOGLE')).toBe(false);

      // LINK_PASSWORD: target null, method FIREBASE_GOOGLE
      expect(isValidReauthActionRule('LINK_PASSWORD', null, 'FIREBASE_GOOGLE')).toBe(true);
      expect(isValidReauthActionRule('LINK_PASSWORD', null, 'PASSWORD')).toBe(false);

      // UNLINK_IDENTITY: PASSWORD requires FIREBASE_GOOGLE, FIREBASE_GOOGLE requires PASSWORD
      expect(isValidReauthActionRule('UNLINK_IDENTITY', 'PASSWORD', 'FIREBASE_GOOGLE')).toBe(true);
      expect(isValidReauthActionRule('UNLINK_IDENTITY', 'FIREBASE_GOOGLE', 'PASSWORD')).toBe(true);
      expect(isValidReauthActionRule('UNLINK_IDENTITY', 'PASSWORD', 'PASSWORD')).toBe(false);
      expect(isValidReauthActionRule('UNLINK_IDENTITY', 'FIREBASE_GOOGLE', 'FIREBASE_GOOGLE')).toBe(false);
      expect(isValidReauthActionRule('UNLINK_IDENTITY', null, 'PASSWORD')).toBe(false);

      // REVOKE_OTHER_SESSION: target sessionId string, method PASSWORD or FIREBASE_GOOGLE
      expect(isValidReauthActionRule('REVOKE_OTHER_SESSION', 'sess_123', 'PASSWORD')).toBe(true);
      expect(isValidReauthActionRule('REVOKE_OTHER_SESSION', 'sess_123', 'FIREBASE_GOOGLE')).toBe(true);
      expect(isValidReauthActionRule('REVOKE_OTHER_SESSION', null, 'PASSWORD')).toBe(false);
      expect(isValidReauthActionRule('REVOKE_OTHER_SESSION', '', 'PASSWORD')).toBe(false);

      // DELETE_ACCOUNT: target null, method PASSWORD or FIREBASE_GOOGLE
      expect(isValidReauthActionRule('DELETE_ACCOUNT', null, 'PASSWORD')).toBe(true);
      expect(isValidReauthActionRule('DELETE_ACCOUNT', null, 'FIREBASE_GOOGLE')).toBe(true);
      expect(isValidReauthActionRule('DELETE_ACCOUNT', 'target', 'PASSWORD')).toBe(false);
    });

    it('enforces immutable consent history item and audit metadata contracts', () => {
      const validConsentItem = {
        eventId: 'evt_12345',
        userId: 'usr_67890',
        policyId: 'privacy_v1',
        consentVersion: '2026-11-22.1',
        consentAt: '2026-11-22T10:00:00.000Z',
      };
      expect(ConsentHistoryItemSchema.safeParse(validConsentItem).success).toBe(true);

      // Missing required audit metadata field fails
      expect(
        ConsentAuditEventMetadataSchema.safeParse({
          userId: 'usr_1',
          policyId: 'pol_1',
          // missing consentVersion
          consentAt: '2026-11-22T10:00:00.000Z',
        }).success
      ).toBe(false);
    });
  });

  describe('Request DTOs & Strict Validation', () => {
    it('validates RegisterRequest and rejects extra fields', () => {
      const valid = {
        email: 'test@example.com',
        password: 'ValidPassword123!',
        displayName: 'Test User',
        consentVersion: '2026-11-22.1',
      };
      expect(RegisterRequestSchema.safeParse(valid).success).toBe(true);

      // Extra fields rejected under strict validation
      expect(RegisterRequestSchema.safeParse({ ...valid, role: 'ADMIN' }).success).toBe(false);
      expect(RegisterRequestSchema.safeParse({ ...valid, admissionToken: 'token' }).success).toBe(false);
    });

    it('validates VerifyEmailRequest', () => {
      expect(
        VerifyEmailRequestSchema.safeParse({
          registrationId: 'reg_12345',
          code: '123456',
        }).success
      ).toBe(true);

      expect(
        VerifyEmailRequestSchema.safeParse({
          registrationId: '',
          code: '123456',
        }).success
      ).toBe(false);
    });

    it('validates ResendOtpRequest', () => {
      expect(ResendOtpRequestSchema.safeParse({ registrationId: 'reg_123' }).success).toBe(true);
      expect(ResendOtpRequestSchema.safeParse({ registrationId: '' }).success).toBe(false);
    });

    it('validates LoginRequest: normalizes password to Unicode NFC and avoids account-enumerating constraints', () => {
      // Decomposed Unicode "Café" -> Caf + combining acute (\u0065\u0301)
      const decomposedPassword = 'Caf\u0065\u030112345';
      const parsed = LoginRequestSchema.parse({
        email: 'test@example.com',
        password: decomposedPassword,
      });
      // Normalized to NFC (\u00E9)
      expect(parsed.password).toBe('Caf\u00E912345');

      // Accepts short wrong password without leaking policy constraints before identity lookup
      const shortPasswordResult = LoginRequestSchema.safeParse({
        email: 'test@example.com',
        password: 'short',
      });
      expect(shortPasswordResult.success).toBe(true);

      // Empty password fails
      expect(
        LoginRequestSchema.safeParse({
          email: 'test@example.com',
          password: '',
        }).success
      ).toBe(false);
    });

    it('validates PasswordForgotRequest and GoogleExchangeRequest', () => {
      expect(
        PasswordForgotRequestSchema.safeParse({
          email: 'test@example.com',
        }).success
      ).toBe(true);

      expect(
        GoogleExchangeRequestSchema.safeParse({
          firebaseIdToken: 'valid_google_token',
        }).success
      ).toBe(true);

      expect(
        GoogleExchangeRequestSchema.safeParse({
          firebaseIdToken: 'valid_google_token',
          consentVersion: '2026-11-22.1',
        }).success
      ).toBe(true);

      expect(
        GoogleExchangeRequestSchema.safeParse({
          firebaseIdToken: '',
        }).success
      ).toBe(false);
    });

    it('validates PasswordResetRequest', () => {
      expect(
        PasswordResetRequestSchema.safeParse({
          email: 'test@example.com',
          code: '654321',
          newPassword: 'NewValidPassword123!',
        }).success
      ).toBe(true);
    });

    it('validates ReauthRequest discriminated union and enforces Table §3.4 rules', () => {
      // Valid password reauth
      expect(
        ReauthRequestSchema.safeParse({
          action: 'CHANGE_PASSWORD',
          method: 'PASSWORD',
          password: 'CurrentPassword123!',
        }).success
      ).toBe(true);

      // Valid google reauth
      expect(
        ReauthRequestSchema.safeParse({
          action: 'LINK_PASSWORD',
          method: 'FIREBASE_GOOGLE',
          firebaseIdToken: 'valid-google-id-token',
        }).success
      ).toBe(true);

      // Forbidden combination: CHANGE_PASSWORD with FIREBASE_GOOGLE fails custom refinement
      const invalidCombination = ReauthRequestSchema.safeParse({
        action: 'CHANGE_PASSWORD',
        method: 'FIREBASE_GOOGLE',
        firebaseIdToken: 'token',
      });
      expect(invalidCombination.success).toBe(false);
    });

    it('validates PasswordChangeRequest and LinkGoogleRequest', () => {
      expect(
        PasswordChangeRequestSchema.safeParse({
          newPassword: 'BrandNewPassword123!',
          reauthTicket: 'ticket_abc123',
        }).success
      ).toBe(true);

      expect(
        LinkGoogleRequestSchema.safeParse({
          firebaseIdToken: 'google_token',
          reauthTicket: 'ticket_abc123',
        }).success
      ).toBe(true);
    });

    it('validates LinkPasswordStartRequest and LinkPasswordRequest', () => {
      expect(
        LinkPasswordStartRequestSchema.safeParse({
          reauthTicket: 'ticket_123',
        }).success
      ).toBe(true);

      expect(
        LinkPasswordRequestSchema.safeParse({
          newPassword: 'NewPassword123!',
          emailCode: '123456',
          reauthTicket: 'ticket_123',
        }).success
      ).toBe(true);
    });

    it('validates UnlinkIdentityRequest and RevokeSessionRequest', () => {
      expect(UnlinkIdentityRequestSchema.safeParse({ reauthTicket: 'ticket_123' }).success).toBe(true);
      expect(RevokeSessionRequestSchema.safeParse({}).success).toBe(true);
      expect(RevokeSessionRequestSchema.safeParse({ reauthTicket: 'ticket_123' }).success).toBe(true);
    });

    it('validates PhoneStartRequest and PhoneVerifyRequest', () => {
      expect(PhoneStartRequestSchema.safeParse({ phoneE164: '+14155552671' }).success).toBe(true);
      expect(
        PhoneVerifyRequestSchema.safeParse({ phoneE164: '+14155552671', code: '123456' }).success
      ).toBe(true);
    });

    it('validates PatchMeRequest: strictly rejects sensitive role/status/consent/plan fields', () => {
      // Allowed fields
      expect(
        PatchMeRequestSchema.safeParse({
          displayName: 'Updated Name',
          preferences: { language: 'en', reducedMotion: true },
        }).success
      ).toBe(true);

      // Prohibited fields rejected under strict schema
      expect(PatchMeRequestSchema.safeParse({ role: 'ADMIN' }).success).toBe(false);
      expect(PatchMeRequestSchema.safeParse({ accountStatus: 'ACTIVE' }).success).toBe(false);
      expect(PatchMeRequestSchema.safeParse({ consentVersion: '2026-11-22.2' }).success).toBe(false);
      expect(PatchMeRequestSchema.safeParse({ plan: 'VIP' }).success).toBe(false);
      expect(PatchMeRequestSchema.safeParse({ emailVerified: true }).success).toBe(false);
      expect(PatchMeRequestSchema.safeParse({ sessionEpoch: 2 }).success).toBe(false);
    });

    it('validates PostConsentRequest and DeleteAccountRequest', () => {
      expect(PostConsentRequestSchema.safeParse({ consentVersion: '2026-11-22.1' }).success).toBe(true);
      expect(PostConsentRequestSchema.safeParse({ consentVersion: '' }).success).toBe(false);

      expect(
        DeleteAccountRequestSchema.safeParse({
          reauthTicket: 'ticket_123',
          confirmation: 'DELETE MY ACCOUNT',
        }).success
      ).toBe(true);

      expect(
        DeleteAccountRequestSchema.safeParse({
          reauthTicket: 'ticket_123',
          confirmation: 'delete my account', // must match exact literal
        }).success
      ).toBe(false);
    });
  });

  describe('Response DTOs & Credential Sanitization Invariant', () => {
    it('SessionResponseSchema validates session envelope and NEVER contains credential secrets', () => {
      const validSessionResponse = {
        data: {
          accessToken: 'header.payload.signature',
          tokenType: 'Bearer' as const,
          expiresInSeconds: 600,
          user: {
            id: '507f1f77bcf86cd799439011',
            email: 'member@example.com',
            emailVerified: true,
            displayName: 'Test Candidate',
            role: 'CANDIDATE' as const,
            accountStatus: 'ACTIVE' as const,
          },
          session: {
            id: 'sess_12345',
            expiresAt: '2026-12-22T16:00:00.000Z',
          },
        },
        meta: {
          requestId: 'req_00000000-0000-4000-8000-000000000000',
        },
      };

      const result = SessionResponseSchema.safeParse(validSessionResponse);
      expect(result.success).toBe(true);

      // Verify that AuthUserDto schema rejects credential fields
      expect(
        AuthUserDtoSchema.safeParse({
          ...validSessionResponse.data.user,
          passwordHash: 'argon2id_hash_should_never_be_here',
        }).success
      ).toBe(false);

      expect(
        AuthUserDtoSchema.safeParse({
          ...validSessionResponse.data.user,
          otpDigest: 'otp_digest_leak',
        }).success
      ).toBe(false);

      expect(
        AuthUserDtoSchema.safeParse({
          ...validSessionResponse.data.user,
          refreshDigest: 'refresh_digest_leak',
        }).success
      ).toBe(false);
    });

    it('GetMeResponseSchema and DataExportResponseSchema strictly sanitize secret credential fields', () => {
      const validMeData = {
        id: 'usr_1',
        email: 'user@example.com',
        emailVerified: true,
        displayName: 'Candidate User',
        role: 'CANDIDATE' as const,
        accountStatus: 'ACTIVE' as const,
        linkedProviders: ['PASSWORD' as const],
        consentVersion: '2026-11-22.1',
        preferences: { language: 'en' as const, reducedMotion: false, timezone: 'UTC' },
      };

      const meResponse = {
        data: validMeData,
        meta: { requestId: 'req_1' },
      };
      expect(GetMeResponseSchema.safeParse(meResponse).success).toBe(true);

      // Rejects secret fields in profile
      expect(GetMeResponseSchema.safeParse({ data: { ...validMeData, passwordHash: 'hash' }, meta: { requestId: 'req_1' } }).success).toBe(false);
      expect(GetMeResponseSchema.safeParse({ data: { ...validMeData, nonceDigest: 'digest' }, meta: { requestId: 'req_1' } }).success).toBe(false);
      expect(GetMeResponseSchema.safeParse({ data: { ...validMeData, ticketDigest: 'digest' }, meta: { requestId: 'req_1' } }).success).toBe(false);

      // Data export
      const exportResponse = {
        data: {
          identityProfile: validMeData,
          linkedProviderTypes: ['PASSWORD' as const],
          consentHistory: [
            {
              eventId: 'evt_1',
              userId: 'usr_1',
              policyId: 'policy_v1',
              consentVersion: '2026-11-22.1',
              consentAt: '2026-11-22T10:00:00.000Z',
            },
          ],
          accountStatus: 'ACTIVE' as const,
          exportedAt: '2026-11-22T11:00:00.000Z',
        },
        meta: { requestId: 'req_2' },
      };
      expect(DataExportResponseSchema.safeParse(exportResponse).success).toBe(true);
    });

    it('AuthMetaResponseSchema validates public policy discovery metadata without secrets', () => {
      const metaResponse = {
        data: {
          activePolicyId: 'privacy_terms_v1',
          activeConsentVersion: '2026-11-22.1',
          registrationMode: 'PUBLIC' as const,
        },
        meta: { requestId: 'req_meta_1' },
      };
      expect(AuthMetaResponseSchema.safeParse(metaResponse).success).toBe(true);
    });
  });
});
