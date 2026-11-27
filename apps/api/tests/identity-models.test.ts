import { describe, it, expect } from 'vitest';
import mongoose, { Connection, Types } from 'mongoose';
import {
  PendingRegistrationModel,
  UserModel,
  AuthIdentityModel,
  SessionModel,
  VerificationChallengeModel,
  ReauthTicketModel,
  AuthRateLimitModel,
  EmailSendBudgetModel,
  SecurityAuditEventModel,
  RegistrationAllowlistModel,
  getUserModel,
  getAuthIdentityModel,
  getSessionModel,
  getVerificationChallengeModel,
  getReauthTicketModel,
  getPendingRegistrationModel,
  getAuthRateLimitModel,
  getEmailSendBudgetModel,
  getSecurityAuditEventModel,
  getRegistrationAllowlistModel,
  REQUIRED_IDENTITY_INDEXES,
  matchesKey,
  verifyIdentityIndexes,
} from '../src/modules/identity/models/index.js';

describe('Phase 2 Auth Identity & Persistence Models (P2-AUTH-01)', () => {
  describe('Connection-Safe Model Registration', () => {
    it('supports retrieving models from connection without duplicate model errors', () => {
      // Calling getters repeatedly on default connection returns the existing registered model
      const userModel1 = getUserModel(mongoose.connection);
      const userModel2 = getUserModel(mongoose.connection);
      expect(userModel1).toBe(userModel2);
      expect(userModel1.modelName).toBe('User');

      const sessionModel1 = getSessionModel(mongoose.connection);
      const sessionModel2 = getSessionModel(mongoose.connection);
      expect(sessionModel1).toBe(sessionModel2);
      expect(sessionModel1.modelName).toBe('Session');

      expect(getPendingRegistrationModel(mongoose.connection).modelName).toBe('PendingRegistration');
      expect(getAuthIdentityModel(mongoose.connection).modelName).toBe('AuthIdentity');
      expect(getVerificationChallengeModel(mongoose.connection).modelName).toBe('VerificationChallenge');
      expect(getReauthTicketModel(mongoose.connection).modelName).toBe('ReauthTicket');
      expect(getAuthRateLimitModel(mongoose.connection).modelName).toBe('AuthRateLimit');
      expect(getEmailSendBudgetModel(mongoose.connection).modelName).toBe('EmailSendBudget');
      expect(getSecurityAuditEventModel(mongoose.connection).modelName).toBe('SecurityAuditEvent');
      expect(getRegistrationAllowlistModel(mongoose.connection).modelName).toBe('RegistrationAllowlist');
    });
  });

  describe('User Schema Validation & Critical Invariants', () => {
    it('strictly rejects PENDING_EMAIL and invalid accountStatus enum values', async () => {
      // Valid statuses
      for (const status of ['ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const) {
        const validDoc = new UserModel({
          displayName: 'Test User',
          emailNormalized: 'test@example.com',
          role: 'CANDIDATE',
          accountStatus: status,
          consentVersion: '2026-11-22.1',
        });
        await expect(validDoc.validate()).resolves.toBeUndefined();
      }

      // Critical invariant: NO PENDING_EMAIL user account
      const pendingEmailDoc = new UserModel({
        displayName: 'Test User',
        emailNormalized: 'test@example.com',
        role: 'CANDIDATE',
        accountStatus: 'PENDING_EMAIL' as unknown as 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      await expect(pendingEmailDoc.validate()).rejects.toThrow(/accountStatus/);

      // Unknown status rejected
      const invalidDoc = new UserModel({
        displayName: 'Test User',
        role: 'CANDIDATE',
        accountStatus: 'UNVERIFIED' as unknown as 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      await expect(invalidDoc.validate()).rejects.toThrow(/accountStatus/);
    });

    it('validates UserRole and rejects unauthorized role values', async () => {
      const adminDoc = new UserModel({
        displayName: 'Admin User',
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      await expect(adminDoc.validate()).resolves.toBeUndefined();

      const candidateDoc = new UserModel({
        displayName: 'Candidate User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      await expect(candidateDoc.validate()).resolves.toBeUndefined();

      const invalidRoleDoc = new UserModel({
        displayName: 'Hacker User',
        role: 'SUPERADMIN' as unknown as 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      await expect(invalidRoleDoc.validate()).rejects.toThrow(/role/);
    });

    it('requires displayName and consentVersion on User', async () => {
      const missingDoc = new UserModel({});
      await expect(missingDoc.validate()).rejects.toThrow();
    });

    it('defaults sessionEpoch and identityVersion to 1 as distinct fields', () => {
      const doc = new UserModel({
        displayName: 'Test User',
        consentVersion: '2026-11-22.1',
      });
      expect(doc.sessionEpoch).toBe(1);
      expect(doc.identityVersion).toBe(1);
      expect(doc.accountStatus).toBe('ACTIVE');
      expect(doc.role).toBe('CANDIDATE');
    });
  });

  describe('AuthIdentity Schema Validation', () => {
    it('validates AuthIdentity fields and provider enum', async () => {
      const validPasswordIdentity = new AuthIdentityModel({
        userId: new Types.ObjectId(),
        provider: 'PASSWORD',
        subject: 'user@example.com',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$fakehash',
      });
      await expect(validPasswordIdentity.validate()).resolves.toBeUndefined();

      const validGoogleIdentity = new AuthIdentityModel({
        userId: new Types.ObjectId(),
        provider: 'FIREBASE_GOOGLE',
        subject: 'firebase_uid_123456789',
      });
      await expect(validGoogleIdentity.validate()).resolves.toBeUndefined();

      const invalidProvider = new AuthIdentityModel({
        userId: new Types.ObjectId(),
        provider: 'GITHUB' as unknown as 'PASSWORD',
        subject: 'github_user',
        passwordHash: 'hash',
      });
      await expect(invalidProvider.validate()).rejects.toThrow(/provider/);
    });

    it('requires a valid passwordHash for PASSWORD identities and rejects missing/empty values', async () => {
      // Missing passwordHash on PASSWORD identity fails
      const missingPasswordHash = new AuthIdentityModel({
        userId: new Types.ObjectId(),
        provider: 'PASSWORD',
        subject: 'user@example.com',
      });
      await expect(missingPasswordHash.validate()).rejects.toThrow(/passwordHash is required for PASSWORD identity/);

      // Empty string passwordHash fails
      const emptyPasswordHash = new AuthIdentityModel({
        userId: new Types.ObjectId(),
        provider: 'PASSWORD',
        subject: 'user@example.com',
        passwordHash: '   ',
      });
      await expect(emptyPasswordHash.validate()).rejects.toThrow(/passwordHash/);
    });

    it('strictly rejects passwordHash on FIREBASE_GOOGLE identities', async () => {
      const googleWithPasswordHash = new AuthIdentityModel({
        userId: new Types.ObjectId(),
        provider: 'FIREBASE_GOOGLE',
        subject: 'firebase_uid_123456789',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$unexpected_hash',
      });
      await expect(googleWithPasswordHash.validate()).rejects.toThrow(
        /passwordHash must be omitted for FIREBASE_GOOGLE identities/
      );
    });
  });

  describe('Session Schema Validation', () => {
    it('validates Session status enum and required fields', async () => {
      for (const status of ['ACTIVE', 'REVOKED', 'COMPROMISED', 'EXPIRED'] as const) {
        const session = new SessionModel({
          sessionId: 'sess_123',
          userId: new Types.ObjectId(),
          status,
          epochAtIssue: 1,
          idleExpiresAt: new Date(Date.now() + 7 * 86400 * 1000),
          absoluteExpiresAt: new Date(Date.now() + 30 * 86400 * 1000),
        });
        await expect(session.validate()).resolves.toBeUndefined();
      }

      const invalidStatus = new SessionModel({
        sessionId: 'sess_123',
        userId: new Types.ObjectId(),
        status: 'IDLE' as unknown as 'ACTIVE',
        epochAtIssue: 1,
        idleExpiresAt: new Date(),
        absoluteExpiresAt: new Date(),
      });
      await expect(invalidStatus.validate()).rejects.toThrow(/status/);
    });
  });

  describe('VerificationChallenge Schema & Invariant Enforcement', () => {
    it('strictly requires userId, identityVersionAtIssue, and passwordIdentityIdAtIssue for RESET_PASSWORD', async () => {
      // Missing all three recovery bindings
      const challengeWithoutBindings = new VerificationChallengeModel({
        challengeId: 'chal_1',
        purpose: 'RESET_PASSWORD',
        subjectDigest: 'sha256_subject',
        otpDigest: 'sha256_otp',
        expiresAt: new Date(Date.now() + 300 * 1000),
      });

      await expect(challengeWithoutBindings.validate()).rejects.toThrow(
        /userId is required for RESET_PASSWORD, LINK_PASSWORD, and PHONE_VERIFY challenges/
      );

      // With userId only
      challengeWithoutBindings.userId = new Types.ObjectId();
      await expect(challengeWithoutBindings.validate()).rejects.toThrow(
        /identityVersionAtIssue is required for RESET_PASSWORD verification challenge/
      );

      // With userId and identityVersionAtIssue only
      challengeWithoutBindings.identityVersionAtIssue = 2;
      await expect(challengeWithoutBindings.validate()).rejects.toThrow(
        /passwordIdentityIdAtIssue is required for RESET_PASSWORD verification challenge/
      );

      // With all three required bindings: passes validation
      challengeWithoutBindings.passwordIdentityIdAtIssue = new Types.ObjectId();
      await expect(challengeWithoutBindings.validate()).resolves.toBeUndefined();
    });

    it('requires userId, sessionId, and reauthTicketDigest for LINK_PASSWORD challenges', async () => {
      // Missing userId, sessionId, reauthTicketDigest
      const linkWithoutBindings = new VerificationChallengeModel({
        challengeId: 'chal_link_1',
        purpose: 'LINK_PASSWORD',
        subjectDigest: 'sha256_subject',
        otpDigest: 'sha256_otp',
        expiresAt: new Date(Date.now() + 300 * 1000),
      });
      await expect(linkWithoutBindings.validate()).rejects.toThrow(
        /userId is required for RESET_PASSWORD, LINK_PASSWORD, and PHONE_VERIFY challenges/
      );

      // With userId only: fails on missing sessionId
      linkWithoutBindings.userId = new Types.ObjectId();
      await expect(linkWithoutBindings.validate()).rejects.toThrow(
        /sessionId is required for LINK_PASSWORD verification challenge/
      );

      // With userId and sessionId: fails on missing reauthTicketDigest
      linkWithoutBindings.sessionId = 'sess_123';
      await expect(linkWithoutBindings.validate()).rejects.toThrow(
        /reauthTicketDigest is required for LINK_PASSWORD verification challenge/
      );

      // With all three required bindings: passes validation
      linkWithoutBindings.reauthTicketDigest = 'sha256_ticket_digest';
      await expect(linkWithoutBindings.validate()).resolves.toBeUndefined();
    });

    it('requires userId for PHONE_VERIFY challenges', async () => {
      const phoneWithoutUser = new VerificationChallengeModel({
        challengeId: 'chal_phone_1',
        purpose: 'PHONE_VERIFY',
        subjectDigest: 'sha256_subject',
        otpDigest: 'sha256_otp',
        expiresAt: new Date(Date.now() + 300 * 1000),
      });
      await expect(phoneWithoutUser.validate()).rejects.toThrow(
        /userId is required for RESET_PASSWORD, LINK_PASSWORD, and PHONE_VERIFY challenges/
      );

      phoneWithoutUser.userId = new Types.ObjectId();
      await expect(phoneWithoutUser.validate()).resolves.toBeUndefined();
    });
  });

  describe('ReauthTicket Schema Validation', () => {
    it('validates reauth action and methodUsed enums', async () => {
      const validTicket = new ReauthTicketModel({
        ticketDigest: 'digest_123',
        userId: new Types.ObjectId(),
        sessionId: 'sess_123',
        action: 'CHANGE_PASSWORD',
        methodUsed: 'PASSWORD',
        sessionEpochAtIssue: 1,
        identityVersionAtIssue: 1,
        expiresAt: new Date(Date.now() + 300 * 1000),
      });
      await expect(validTicket.validate()).resolves.toBeUndefined();

      const invalidAction = new ReauthTicketModel({
        ticketDigest: 'digest_123',
        userId: new Types.ObjectId(),
        sessionId: 'sess_123',
        action: 'UNKNOWN_ACTION' as unknown as 'CHANGE_PASSWORD',
        methodUsed: 'PASSWORD',
        sessionEpochAtIssue: 1,
        identityVersionAtIssue: 1,
        expiresAt: new Date(),
      });
      await expect(invalidAction.validate()).rejects.toThrow(/action/);

      const invalidMethod = new ReauthTicketModel({
        ticketDigest: 'digest_123',
        userId: new Types.ObjectId(),
        sessionId: 'sess_123',
        action: 'CHANGE_PASSWORD',
        methodUsed: 'SMS' as unknown as 'PASSWORD',
        sessionEpochAtIssue: 1,
        identityVersionAtIssue: 1,
        expiresAt: new Date(),
      });
      await expect(invalidMethod.validate()).rejects.toThrow(/methodUsed/);
    });
  });

  describe('SecurityAuditEvent Schema & Immutability Invariant', () => {
    it('strictly validates CONSENT_ACCEPTED metadata types, nonempty identifiers and valid timestamps', async () => {
      // Missing metadata entirely
      const missingMeta = new SecurityAuditEventModel({
        eventId: 'evt_1',
        eventType: 'CONSENT_ACCEPTED',
        requestId: 'req_1',
        outcome: 'SUCCESS',
        metadata: {},
      });
      await expect(missingMeta.validate()).rejects.toThrow(
        /userId \(non-empty string\), policyId \(non-empty string\), consentVersion \(non-empty string\), and consentAt \(valid timestamp\) are required/
      );

      // Empty or whitespace identifiers rejected
      const emptyUserMeta = new SecurityAuditEventModel({
        eventId: 'evt_1',
        eventType: 'CONSENT_ACCEPTED',
        requestId: 'req_1',
        outcome: 'SUCCESS',
        metadata: {
          userId: '   ',
          policyId: 'policy_v1',
          consentVersion: '2026-11-22.1',
          consentAt: new Date(),
        },
      });
      await expect(emptyUserMeta.validate()).rejects.toThrow(/userId/);

      // Non-string userId rejected
      const nonStringUserMeta = new SecurityAuditEventModel({
        eventId: 'evt_1',
        eventType: 'CONSENT_ACCEPTED',
        requestId: 'req_1',
        outcome: 'SUCCESS',
        metadata: {
          userId: 12345 as unknown as string,
          policyId: 'policy_v1',
          consentVersion: '2026-11-22.1',
          consentAt: new Date(),
        },
      });
      await expect(nonStringUserMeta.validate()).rejects.toThrow(/userId/);

      // Empty policyId rejected
      const emptyPolicyMeta = new SecurityAuditEventModel({
        eventId: 'evt_1',
        eventType: 'CONSENT_ACCEPTED',
        requestId: 'req_1',
        outcome: 'SUCCESS',
        metadata: {
          userId: 'usr_123',
          policyId: '',
          consentVersion: '2026-11-22.1',
          consentAt: new Date(),
        },
      });
      await expect(emptyPolicyMeta.validate()).rejects.toThrow(/policyId/);

      // Invalid consentAt rejected (invalid Date object or unparseable string)
      const invalidDateMeta = new SecurityAuditEventModel({
        eventId: 'evt_1',
        eventType: 'CONSENT_ACCEPTED',
        requestId: 'req_1',
        outcome: 'SUCCESS',
        metadata: {
          userId: 'usr_123',
          policyId: 'policy_v1',
          consentVersion: '2026-11-22.1',
          consentAt: new Date('invalid date'),
        },
      });
      await expect(invalidDateMeta.validate()).rejects.toThrow(/consentAt/);

      const unparseableStringMeta = new SecurityAuditEventModel({
        eventId: 'evt_1',
        eventType: 'CONSENT_ACCEPTED',
        requestId: 'req_1',
        outcome: 'SUCCESS',
        metadata: {
          userId: 'usr_123',
          policyId: 'policy_v1',
          consentVersion: '2026-11-22.1',
          consentAt: 'not-a-timestamp',
        },
      });
      await expect(unparseableStringMeta.validate()).rejects.toThrow(/consentAt/);

      // Valid with Date instance
      const validWithDate = new SecurityAuditEventModel({
        eventId: 'evt_valid_date',
        eventType: 'CONSENT_ACCEPTED',
        requestId: 'req_1',
        outcome: 'SUCCESS',
        metadata: {
          userId: 'usr_123',
          policyId: 'policy_v1',
          consentVersion: '2026-11-22.1',
          consentAt: new Date(),
        },
      });
      await expect(validWithDate.validate()).resolves.toBeUndefined();

      // Valid with ISO string timestamp
      const validWithString = new SecurityAuditEventModel({
        eventId: 'evt_valid_str',
        eventType: 'CONSENT_ACCEPTED',
        requestId: 'req_2',
        outcome: 'SUCCESS',
        metadata: {
          userId: 'usr_123',
          policyId: 'policy_v1',
          consentVersion: '2026-11-22.1',
          consentAt: '2026-11-22T10:00:00.000Z',
        },
      });
      await expect(validWithString.validate()).resolves.toBeUndefined();
    });

    it('enforces immutability: throws on attempts to save modified existing audit event', async () => {
      const eventDoc = new SecurityAuditEventModel({
        eventId: 'evt_immutable_test',
        eventType: 'LOGIN_ATTEMPT',
        requestId: 'req_imm',
        outcome: 'SUCCESS',
      });

      // Mark document as not new to simulate existing document save
      eventDoc.isNew = false;
      await expect(eventDoc.save()).rejects.toThrow(
        /Security audit events are immutable and cannot be updated/
      );
    });

    it('blocks ordinary Mongoose update, replace, and deletion paths while preserving explicit retentionPurge exception', async () => {
      // 1. Query update and replace paths throw unconditionally
      const updateQuery = SecurityAuditEventModel.updateOne(
        { eventId: 'evt_1' },
        { outcome: 'FAILURE' }
      );
      await expect(updateQuery.exec()).rejects.toThrow(
        /Security audit events are immutable and cannot be updated or replaced/
      );

      const findOneAndUpdateQuery = SecurityAuditEventModel.findOneAndUpdate(
        { eventId: 'evt_1' },
        { outcome: 'FAILURE' }
      );
      await expect(findOneAndUpdateQuery.exec()).rejects.toThrow(
        /Security audit events are immutable and cannot be updated or replaced/
      );

      const replaceQuery = SecurityAuditEventModel.replaceOne(
        { eventId: 'evt_1' },
        { eventId: 'evt_1', eventType: 'TAMPERED', requestId: 'req', outcome: 'FAILURE', at: new Date() }
      );
      await expect(replaceQuery.exec()).rejects.toThrow(
        /Security audit events are immutable and cannot be updated or replaced/
      );

      // 2. Query deletion without retentionPurge throws
      const ordinaryDeleteQuery = SecurityAuditEventModel.deleteOne({ eventId: 'evt_1' });
      await expect(ordinaryDeleteQuery.exec()).rejects.toThrow(
        /Security audit events cannot be deleted except via explicit authorized retentionPurge/
      );

      const ordinaryDeleteManyQuery = SecurityAuditEventModel.deleteMany({});
      await expect(ordinaryDeleteManyQuery.exec()).rejects.toThrow(
        /Security audit events cannot be deleted except via explicit authorized retentionPurge/
      );

      const ordinaryFindAndDeleteQuery = SecurityAuditEventModel.findOneAndDelete({ eventId: 'evt_1' });
      await expect(ordinaryFindAndDeleteQuery.exec()).rejects.toThrow(
        /Security audit events cannot be deleted except via explicit authorized retentionPurge/
      );

      // 3. Document deletion without retentionPurge throws
      const doc = new SecurityAuditEventModel({
        eventId: 'evt_doc_del',
        eventType: 'LOGIN_ATTEMPT',
        requestId: 'req_del',
        outcome: 'SUCCESS',
      });
      await expect(doc.deleteOne()).rejects.toThrow(
        /Security audit events cannot be deleted except via explicit authorized retentionPurge/
      );
    });
  });

  describe('Other Persistence Models Validation', () => {
    it('validates PendingRegistration fields and required digests', async () => {
      const pending = new PendingRegistrationModel({
        registrationId: 'reg_123',
        emailNormalized: 'pending@example.com',
        passwordHash: 'hash',
        nonceDigest: 'nonce_digest',
        otpDigest: 'otp_digest',
        consentVersion: '2026-11-22.1',
        otpExpiresAt: new Date(Date.now() + 300 * 1000),
        expiresAt: new Date(Date.now() + 900 * 1000),
      });
      await expect(pending.validate()).resolves.toBeUndefined();
    });

    it('validates AuthRateLimit, EmailSendBudget, and RegistrationAllowlist', async () => {
      const rateLimit = new AuthRateLimitModel({
        bucketKey: 'bucket_hash_1',
        windowEnd: new Date(),
        expiresAt: new Date(),
      });
      await expect(rateLimit.validate()).resolves.toBeUndefined();

      const budget = new EmailSendBudgetModel({
        dateKey: '2026-11-22',
        generalUsed: 5,
        recoveryUsed: 1,
      });
      await expect(budget.validate()).resolves.toBeUndefined();

      const allowlist = new RegistrationAllowlistModel({
        emailNormalized: 'vip@example.com',
        createdBy: 'operator_1',
      });
      await expect(allowlist.validate()).resolves.toBeUndefined();
    });
  });

  describe('Critical Index Definitions & Inventory Verification', () => {
    it('defines exactly the 10 required identity collections in inventory', () => {
      const collectionNames = REQUIRED_IDENTITY_INDEXES.map((r) => r.collectionName);
      expect(collectionNames).toHaveLength(10);
      expect(collectionNames).toContain('pendingRegistrations');
      expect(collectionNames).toContain('users');
      expect(collectionNames).toContain('authIdentities');
      expect(collectionNames).toContain('sessions');
      expect(collectionNames).toContain('verificationChallenges');
      expect(collectionNames).toContain('reauthTickets');
      expect(collectionNames).toContain('authRateLimits');
      expect(collectionNames).toContain('emailSendBudget');
      expect(collectionNames).toContain('securityAuditEvents');
      expect(collectionNames).toContain('registrationAllowlist');
    });

    it('registers exact required indexes on Mongoose schemas', () => {
      // 1. pendingRegistrations
      const pendingIndexes = PendingRegistrationModel.schema.indexes();
      expect(pendingIndexes.some((idx) => matchesKey(idx[0], { registrationId: 1 }) && idx[1]?.unique)).toBe(true);
      expect(pendingIndexes.some((idx) => matchesKey(idx[0], { emailNormalized: 1 }) && idx[1]?.unique)).toBe(true);
      expect(pendingIndexes.some((idx) => matchesKey(idx[0], { expiresAt: 1 }) && idx[1]?.expireAfterSeconds === 0)).toBe(true);

      // 2. users
      const userIndexes = UserModel.schema.indexes();
      expect(
        userIndexes.some(
          (idx) =>
            matchesKey(idx[0], { emailNormalized: 1 }) &&
            idx[1]?.unique &&
            JSON.stringify(idx[1]?.partialFilterExpression) === JSON.stringify({ emailNormalized: { $type: 'string' } })
        )
      ).toBe(true);
      expect(
        userIndexes.some(
          (idx) =>
            matchesKey(idx[0], { phoneE164: 1 }) &&
            idx[1]?.unique &&
            JSON.stringify(idx[1]?.partialFilterExpression) === JSON.stringify({ phoneE164: { $type: 'string' } })
        )
      ).toBe(true);
      expect(userIndexes.some((idx) => matchesKey(idx[0], { accountStatus: 1, createdAt: 1 }))).toBe(true);

      // 3. authIdentities
      const authIdentityIndexes = AuthIdentityModel.schema.indexes();
      expect(authIdentityIndexes.some((idx) => matchesKey(idx[0], { provider: 1, subject: 1 }) && idx[1]?.unique)).toBe(true);
      expect(authIdentityIndexes.some((idx) => matchesKey(idx[0], { userId: 1, provider: 1 }) && idx[1]?.unique)).toBe(true);
      expect(authIdentityIndexes.some((idx) => matchesKey(idx[0], { userId: 1 }) && !idx[1]?.unique)).toBe(true);

      // 4. sessions
      const sessionIndexes = SessionModel.schema.indexes();
      expect(sessionIndexes.some((idx) => matchesKey(idx[0], { sessionId: 1 }) && idx[1]?.unique)).toBe(true);
      expect(
        sessionIndexes.some(
          (idx) =>
            matchesKey(idx[0], { currentRefreshDigest: 1 }) &&
            idx[1]?.unique &&
            JSON.stringify(idx[1]?.partialFilterExpression) ===
              JSON.stringify({ status: 'ACTIVE', currentRefreshDigest: { $type: 'string' } })
        )
      ).toBe(true);
      expect(sessionIndexes.some((idx) => matchesKey(idx[0], { userId: 1, status: 1, lastUsedAt: -1 }))).toBe(true);
      expect(sessionIndexes.some((idx) => matchesKey(idx[0], { absoluteExpiresAt: 1 }) && idx[1]?.expireAfterSeconds === 0)).toBe(true);

      // 5. verificationChallenges
      const challengeIndexes = VerificationChallengeModel.schema.indexes();
      expect(challengeIndexes.some((idx) => matchesKey(idx[0], { purpose: 1, subjectDigest: 1 }) && idx[1]?.unique)).toBe(true);
      expect(challengeIndexes.some((idx) => matchesKey(idx[0], { challengeId: 1 }) && idx[1]?.unique)).toBe(true);
      expect(challengeIndexes.some((idx) => matchesKey(idx[0], { expiresAt: 1 }) && idx[1]?.expireAfterSeconds === 0)).toBe(true);

      // 6. reauthTickets
      const ticketIndexes = ReauthTicketModel.schema.indexes();
      expect(ticketIndexes.some((idx) => matchesKey(idx[0], { ticketDigest: 1 }) && idx[1]?.unique)).toBe(true);
      expect(ticketIndexes.some((idx) => matchesKey(idx[0], { userId: 1, sessionId: 1, action: 1 }))).toBe(true);
      expect(ticketIndexes.some((idx) => matchesKey(idx[0], { expiresAt: 1 }) && idx[1]?.expireAfterSeconds === 0)).toBe(true);

      // 7. authRateLimits
      const rateIndexes = AuthRateLimitModel.schema.indexes();
      expect(rateIndexes.some((idx) => matchesKey(idx[0], { bucketKey: 1 }) && idx[1]?.unique)).toBe(true);
      expect(rateIndexes.some((idx) => matchesKey(idx[0], { expiresAt: 1 }) && idx[1]?.expireAfterSeconds === 0)).toBe(true);

      // 8. emailSendBudget
      const budgetIndexes = EmailSendBudgetModel.schema.indexes();
      expect(budgetIndexes.some((idx) => matchesKey(idx[0], { dateKey: 1 }) && idx[1]?.unique)).toBe(true);

      // 9. securityAuditEvents
      const auditIndexes = SecurityAuditEventModel.schema.indexes();
      expect(auditIndexes.some((idx) => matchesKey(idx[0], { eventId: 1 }) && idx[1]?.unique)).toBe(true);
      expect(auditIndexes.some((idx) => matchesKey(idx[0], { targetId: 1, at: -1 }))).toBe(true);
      expect(auditIndexes.some((idx) => matchesKey(idx[0], { at: -1 }))).toBe(true);

      // 10. registrationAllowlist
      const allowlistIndexes = RegistrationAllowlistModel.schema.indexes();
      expect(allowlistIndexes.some((idx) => matchesKey(idx[0], { emailNormalized: 1 }) && idx[1]?.unique)).toBe(true);
    });

    it('matchesKey utility correctly matches exact index key shapes', () => {
      expect(matchesKey({ a: 1, b: -1 }, { a: 1, b: -1 })).toBe(true);
      expect(matchesKey({ a: 1 }, { a: 1, b: 1 })).toBe(false);
      expect(matchesKey({ a: 1, b: 1 }, { a: 1, b: -1 })).toBe(false);
      expect(matchesKey({ b: -1, a: 1 }, { a: 1, b: -1 })).toBe(false);
    });

    it('verifyIdentityIndexes utility detects missing indexes accurately', async () => {
      // Mock a connection with an incomplete collection to test verification failure reporting
      const mockConn = {
        models: {
          User: {
            collection: {
              indexes: async () => [{ key: { _id: 1 } }], // missing critical indexes
            },
          },
          PendingRegistration: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
          AuthIdentity: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
          Session: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
          VerificationChallenge: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
          ReauthTicket: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
          AuthRateLimit: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
          EmailSendBudget: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
          SecurityAuditEvent: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
          RegistrationAllowlist: { collection: { indexes: async () => [{ key: { _id: 1 } }] } },
        },
      } as unknown as Connection;

      const verification = await verifyIdentityIndexes(mockConn);
      expect(verification.ok).toBe(false);
      expect(verification.issues.length).toBeGreaterThan(0);
      expect(
        verification.issues.some((issue) => issue.includes('missing required index'))
      ).toBe(true);
    });
  });

  describe('Live Database Environment Check & Integration Test Reporting', () => {
    it('documents whether live MongoDB replica set credentials are present without exposing secrets', () => {
      const uri = process.env.MONGODB_TEST_URI || process.env.MONGODB_URI;
      const isPlaceholder = !uri || uri.includes('placeholder_user') || uri.includes('placeholder_pass');

      if (isPlaceholder) {
        // As mandated in task instructions and AGENTS.md:
        // "If live MongoDB credentials are unavailable, report the integration tests as unverified; do not request, print or commit secrets."
        console.log(
          '[NOTICE] Live MongoDB replica-set credentials unavailable in local test environment; real database duplicate index enforcement integration tests are reported as UNVERIFIED.'
        );
        expect(isPlaceholder).toBe(true);
      } else {
        console.log('[INFO] Live MongoDB URI detected; real database integration tests active.');
        expect(uri).toBeDefined();
      }
    });
  });
});
