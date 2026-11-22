import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose, { Connection, Types } from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import {
  getUserModel,
  getAuthIdentityModel,
  getSessionModel,
  getVerificationChallengeModel,
  getSecurityAuditEventModel,
  ensureIdentityIndexes,
  verifyIdentityIndexes,
  REQUIRED_IDENTITY_INDEXES,
} from '../src/modules/identity/models/index.js';
import {
  SessionKeyring,
  SessionService,
  createRefreshToken,
  createCsrfToken,
  signAccessToken,
} from '../src/modules/auth/session/index.js';
import { loadEnv } from '../src/config/env.js';
import { UnauthorizedError, SessionReplayError } from '../src/core/errors.js';
import {
  EXPECTED_TEST_DB_NAME,
  extractDatabaseName,
  validateIntegrationDatabaseName,
  performHarnessCleanup,
  executeGuaranteedCleanup,
} from './identity-test-harness.js';

export {
  EXPECTED_TEST_DB_NAME,
  extractDatabaseName,
  validateIntegrationDatabaseName,
  performHarnessCleanup,
  executeGuaranteedCleanup,
};

// Auto-load .env if MONGODB_TEST_URI is not in process.env
if (!process.env.MONGODB_TEST_URI && typeof process.loadEnvFile === 'function') {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // ignore
    }
  }
}

const runLive = process.env.RUN_LIVE_MONGODB_TESTS === 'true';

describe.skipIf(!runLive)(
  'P2-AUTH-01: Live MongoDB Atlas Integration Suite',
  { timeout: 30000 },
  () => {
  let conn: Connection;
  let testDbName: string;
  let mongoVersion: string;
  const runId = `live_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const createdUserIds: Types.ObjectId[] = [];
  const createdIdentityIds: Types.ObjectId[] = [];
  const createdSessionIds: string[] = [];
  const createdChallengeIds: string[] = [];

  beforeAll(async () => {
    const uri = process.env.MONGODB_TEST_URI;
    if (!uri || uri.includes('placeholder_user') || uri.includes('placeholder_pass')) {
      throw new Error(
        'Execution halted: Live MongoDB integration tests were explicitly requested (RUN_LIVE_MONGODB_TESTS=true), ' +
          'but MONGODB_TEST_URI is missing or contains placeholder values.\n' +
          'Local setup required: Set MONGODB_TEST_URI in .env to a live MongoDB Atlas connection string pointing to a dedicated test database (e.g. roundset_test).'
      );
    }

    // Safety guardrail: Ensure the test suite refuses to run against any database other than roundset_test
    testDbName = validateIntegrationDatabaseName(uri);

    conn = await mongoose
      .createConnection(uri, {
        serverSelectionTimeoutMS: 15000,
      })
      .asPromise();

    const buildInfo = await conn.db!.admin().buildInfo();
    mongoVersion = buildInfo.version;
  }, 30000);

  afterAll(async () => {
    if (!conn) return;

    await executeGuaranteedCleanup(conn, async () => {
      await performHarnessCleanup(conn, {
        createdUserIds,
        createdIdentityIds,
        createdSessionIds,
        createdChallengeIds,
        runId,
      });
    });
  });

  describe('Connection Verification & Environment Sanity', () => {
    it('successfully connects to live MongoDB Atlas replica set with valid version and test database isolation', () => {
      expect(conn.readyState).toBe(1); // 1 = connected
      expect(testDbName).toBe(EXPECTED_TEST_DB_NAME);
      expect(mongoVersion).toBeDefined();
      expect(typeof mongoVersion).toBe('string');
    });

    it('preserves existing database collections such as smoke_test without dropping database', async () => {
      const collections = await conn.db!.listCollections().toArray();
      const collectionNames = collections.map((c) => c.name);
      // smoke_test collection created by project owner must remain preserved
      expect(collectionNames).toContain('smoke_test');
    });
  });

  describe('Test Group A — Index Creation and Verification', () => {
    it(
      'creates all P2-AUTH-01 indexes and validates compliance via verifyIdentityIndexes()',
      { timeout: 60000 },
      async () => {
        await ensureIdentityIndexes(conn);

        const verification = await verifyIdentityIndexes(conn);
        expect(verification.issues).toEqual([]);
        expect(verification.ok).toBe(true);

        // Verify all 10 required identity collections are present in inventory
        const checkedCollections = Object.keys(verification.details);
        expect(checkedCollections.length).toBe(REQUIRED_IDENTITY_INDEXES.length);
        for (const req of REQUIRED_IDENTITY_INDEXES) {
          expect(checkedCollections).toContain(req.collectionName);
        }
      }
    );

    it('confirms installed unique, partial-filter, and TTL index properties directly from MongoDB', async () => {
      const verification = await verifyIdentityIndexes(conn);
      const { details } = verification;

      // 1. users: partial filter on emailNormalized & phoneE164
      const userIndexes = details['users'];
      const emailIdx = userIndexes.find((i) => i.key['emailNormalized'] === 1);
      expect(emailIdx).toBeDefined();
      expect(emailIdx?.unique).toBe(true);
      expect(emailIdx?.partialFilterExpression).toEqual({ emailNormalized: { $type: 'string' } });

      const phoneIdx = userIndexes.find((i) => i.key['phoneE164'] === 1);
      expect(phoneIdx).toBeDefined();
      expect(phoneIdx?.unique).toBe(true);
      expect(phoneIdx?.partialFilterExpression).toEqual({ phoneE164: { $type: 'string' } });

      // 2. authIdentities: compound unique indexes
      const identityIndexes = details['authIdentities'];
      const provSubIdx = identityIndexes.find(
        (i) => i.key['provider'] === 1 && i.key['subject'] === 1
      );
      expect(provSubIdx).toBeDefined();
      expect(provSubIdx?.unique).toBe(true);

      const userProvIdx = identityIndexes.find(
        (i) => i.key['userId'] === 1 && i.key['provider'] === 1
      );
      expect(userProvIdx).toBeDefined();
      expect(userProvIdx?.unique).toBe(true);

      // 3. sessions: partial unique refresh digest and TTL index
      const sessionIndexes = details['sessions'];
      const refreshIdx = sessionIndexes.find((i) => i.key['currentRefreshDigest'] === 1);
      expect(refreshIdx).toBeDefined();
      expect(refreshIdx?.unique).toBe(true);
      expect(refreshIdx?.partialFilterExpression).toEqual({
        status: 'ACTIVE',
        currentRefreshDigest: { $type: 'string' },
      });

      const sessionTtlIdx = sessionIndexes.find((i) => i.key['absoluteExpiresAt'] === 1);
      expect(sessionTtlIdx).toBeDefined();
      expect(sessionTtlIdx?.expireAfterSeconds).toBe(0);

      // 4. verificationChallenges: unique purpose+subjectDigest and TTL
      const challengeIndexes = details['verificationChallenges'];
      const purposeSubIdx = challengeIndexes.find(
        (i) => i.key['purpose'] === 1 && i.key['subjectDigest'] === 1
      );
      expect(purposeSubIdx).toBeDefined();
      expect(purposeSubIdx?.unique).toBe(true);

      const challengeTtlIdx = challengeIndexes.find((i) => i.key['expiresAt'] === 1);
      expect(challengeTtlIdx).toBeDefined();
      expect(challengeTtlIdx?.expireAfterSeconds).toBe(0);
    });
  });

  describe('Test Group B — Unique Constraints (E11000)', () => {
    it('produces E11000 when inserting two users with the same verified canonical email', async () => {
      const UserModel = getUserModel(conn);
      const duplicateEmail = `${runId}_dup_user@example.com`;

      const user1 = await UserModel.create({
        emailNormalized: duplicateEmail,
        displayName: 'First User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      createdUserIds.push(user1._id);

      let caughtError: unknown;
      try {
        await UserModel.create({
          emailNormalized: duplicateEmail,
          displayName: 'Second User Colliding',
          role: 'CANDIDATE',
          accountStatus: 'ACTIVE',
          consentVersion: '2026-11-22.1',
        });
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const mongoErr = caughtError as { code?: number; message?: string };
      expect(mongoErr.code).toBe(11000);
      expect(mongoErr.message).toMatch(/E11000 duplicate key error.*emailNormalized/);
    });

    it('produces E11000 when inserting two Firebase identities with the same provider UID', async () => {
      const UserModel = getUserModel(conn);
      const AuthIdentityModel = getAuthIdentityModel(conn);
      const duplicateFirebaseUid = `firebase_uid_${runId}`;

      const userA = await UserModel.create({
        emailNormalized: `${runId}_firebase_a@example.com`,
        displayName: 'Firebase User A',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      const userB = await UserModel.create({
        emailNormalized: `${runId}_firebase_b@example.com`,
        displayName: 'Firebase User B',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      createdUserIds.push(userA._id, userB._id);

      const identA = await AuthIdentityModel.create({
        userId: userA._id,
        provider: 'FIREBASE_GOOGLE',
        subject: duplicateFirebaseUid,
      });
      createdIdentityIds.push(identA._id);

      let caughtError: unknown;
      try {
        await AuthIdentityModel.create({
          userId: userB._id,
          provider: 'FIREBASE_GOOGLE',
          subject: duplicateFirebaseUid,
        });
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const mongoErr = caughtError as { code?: number; message?: string };
      expect(mongoErr.code).toBe(11000);
      expect(mongoErr.message).toMatch(/E11000 duplicate key error.*provider_1_subject_1/);
    });

    it('produces E11000 when inserting two identities with the same (userId, provider)', async () => {
      const UserModel = getUserModel(conn);
      const AuthIdentityModel = getAuthIdentityModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_single_user@example.com`,
        displayName: 'Single User Two Passwords',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      createdUserIds.push(user._id);

      const ident1 = await AuthIdentityModel.create({
        userId: user._id,
        provider: 'PASSWORD',
        subject: user.emailNormalized,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$syntheticHash1',
      });
      createdIdentityIds.push(ident1._id);

      let caughtError: unknown;
      try {
        await AuthIdentityModel.create({
          userId: user._id,
          provider: 'PASSWORD',
          subject: `${runId}_other_subject@example.com`,
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$syntheticHash2',
        });
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const mongoErr = caughtError as { code?: number; message?: string };
      expect(mongoErr.code).toBe(11000);
      expect(mongoErr.message).toMatch(/E11000 duplicate key error.*userId_1_provider_1/);
    });

    it('produces E11000 when inserting two OTP challenges with the same (purpose, subjectDigest)', async () => {
      const UserModel = getUserModel(conn);
      const AuthIdentityModel = getAuthIdentityModel(conn);
      const VerificationChallengeModel = getVerificationChallengeModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_otp_user@example.com`,
        displayName: 'OTP User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      const ident = await AuthIdentityModel.create({
        userId: user._id,
        provider: 'PASSWORD',
        subject: user.emailNormalized,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$pwdHash',
      });
      createdUserIds.push(user._id);
      createdIdentityIds.push(ident._id);

      const sharedSubjectDigest = `digest_${runId}_shared`;

      const ch1 = await VerificationChallengeModel.create({
        challengeId: `${runId}_ch_1`,
        purpose: 'RESET_PASSWORD',
        subjectDigest: sharedSubjectDigest,
        userId: user._id,
        identityVersionAtIssue: 1,
        passwordIdentityIdAtIssue: ident._id,
        otpDigest: `otp_digest_1_${runId}`,
        expiresAt: new Date(Date.now() + 300000),
      });
      createdChallengeIds.push(ch1.challengeId);

      let caughtError: unknown;
      try {
        await VerificationChallengeModel.create({
          challengeId: `${runId}_ch_2`,
          purpose: 'RESET_PASSWORD',
          subjectDigest: sharedSubjectDigest,
          userId: user._id,
          identityVersionAtIssue: 1,
          passwordIdentityIdAtIssue: ident._id,
          otpDigest: `otp_digest_2_${runId}`,
          expiresAt: new Date(Date.now() + 300000),
        });
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const mongoErr = caughtError as { code?: number; message?: string };
      expect(mongoErr.code).toBe(11000);
      expect(mongoErr.message).toMatch(/E11000 duplicate key error.*purpose_1_subjectDigest_1/);
    });

    it('allows multiple revoked sessions without an active refresh digest to coexist', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_revoked_user@example.com`,
        displayName: 'Revoked Session User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      createdUserIds.push(user._id);

      const now = Date.now();
      const sess1Id = `${runId}_rev_s1`;
      const sess2Id = `${runId}_rev_s2`;
      const sess3Id = `${runId}_rev_s3_same_digest`;
      const sess4Id = `${runId}_rev_s4_same_digest`;

      // Two revoked sessions with undefined refresh digest
      const sess1 = await SessionModel.create({
        sessionId: sess1Id,
        userId: user._id,
        status: 'REVOKED',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now + 3600000),
        absoluteExpiresAt: new Date(now + 86400000),
      });
      const sess2 = await SessionModel.create({
        sessionId: sess2Id,
        userId: user._id,
        status: 'REVOKED',
        epochAtIssue: 1,
        idleExpiresAt: new Date(now + 3600000),
        absoluteExpiresAt: new Date(now + 86400000),
      });

      // Two revoked sessions sharing the same former refresh digest
      const formerDigest = `former_digest_${runId}`;
      const sess3 = await SessionModel.create({
        sessionId: sess3Id,
        userId: user._id,
        status: 'REVOKED',
        currentRefreshDigest: formerDigest,
        epochAtIssue: 1,
        idleExpiresAt: new Date(now + 3600000),
        absoluteExpiresAt: new Date(now + 86400000),
      });
      const sess4 = await SessionModel.create({
        sessionId: sess4Id,
        userId: user._id,
        status: 'REVOKED',
        currentRefreshDigest: formerDigest,
        epochAtIssue: 1,
        idleExpiresAt: new Date(now + 3600000),
        absoluteExpiresAt: new Date(now + 86400000),
      });

      createdSessionIds.push(sess1Id, sess2Id, sess3Id, sess4Id);

      expect(sess1.sessionId).toBe(sess1Id);
      expect(sess2.sessionId).toBe(sess2Id);
      expect(sess3.sessionId).toBe(sess3Id);
      expect(sess4.sessionId).toBe(sess4Id);

      const count = await SessionModel.countDocuments({
        sessionId: { $in: [sess1Id, sess2Id, sess3Id, sess4Id] },
      });
      expect(count).toBe(4);
    });
  });

  describe('Test Group C — Multi-Document Transactions', () => {
    it('Transaction Commit: atomically writes synthetic user and identity across collections', async () => {
      const UserModel = getUserModel(conn);
      const AuthIdentityModel = getAuthIdentityModel(conn);

      const session = await conn.startSession();
      session.startTransaction();

      let committedUserId: Types.ObjectId | undefined;
      let committedIdentityId: Types.ObjectId | undefined;

      try {
        const [user] = await UserModel.create(
          [
            {
              emailNormalized: `${runId}_tx_commit@example.com`,
              displayName: 'Tx Commit User',
              role: 'CANDIDATE',
              accountStatus: 'ACTIVE',
              consentVersion: '2026-11-22.1',
            },
          ],
          { session }
        );
        committedUserId = user._id;

        const [identity] = await AuthIdentityModel.create(
          [
            {
              userId: user._id,
              provider: 'PASSWORD',
              subject: user.emailNormalized,
              passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$txCommitHash',
            },
          ],
          { session }
        );
        committedIdentityId = identity._id;

        await session.commitTransaction();
      } finally {
        await session.endSession();
      }

      expect(committedUserId).toBeDefined();
      expect(committedIdentityId).toBeDefined();
      createdUserIds.push(committedUserId!);
      createdIdentityIds.push(committedIdentityId!);

      // Verify both records exist outside the transaction
      const persistedUser = await UserModel.findById(committedUserId);
      const persistedIdentity = await AuthIdentityModel.findById(committedIdentityId);

      expect(persistedUser).not.toBeNull();
      expect(persistedUser?.emailNormalized).toBe(`${runId}_tx_commit@example.com`);
      expect(persistedIdentity).not.toBeNull();
      expect(persistedIdentity?.userId.toString()).toBe(committedUserId!.toString());
    });

    it('Transaction Rollback: aborts and leaves neither user nor identity persisted', async () => {
      const UserModel = getUserModel(conn);
      const AuthIdentityModel = getAuthIdentityModel(conn);

      const session = await conn.startSession();
      session.startTransaction();

      let rolledBackUserId: Types.ObjectId | undefined;
      let rolledBackIdentityId: Types.ObjectId | undefined;

      try {
        const [user] = await UserModel.create(
          [
            {
              emailNormalized: `${runId}_tx_rollback@example.com`,
              displayName: 'Tx Rollback User',
              role: 'CANDIDATE',
              accountStatus: 'ACTIVE',
              consentVersion: '2026-11-22.1',
            },
          ],
          { session }
        );
        rolledBackUserId = user._id;

        const [identity] = await AuthIdentityModel.create(
          [
            {
              userId: user._id,
              provider: 'PASSWORD',
              subject: user.emailNormalized,
              passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$txRollbackHash',
            },
          ],
          { session }
        );
        rolledBackIdentityId = identity._id;

        // Verify both exist inside the active transaction
        const insideUser = await UserModel.findById(user._id).session(session);
        const insideIdentity = await AuthIdentityModel.findById(identity._id).session(session);
        expect(insideUser).not.toBeNull();
        expect(insideIdentity).not.toBeNull();

        // Intentionally abort transaction
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }

      expect(rolledBackUserId).toBeDefined();
      expect(rolledBackIdentityId).toBeDefined();

      // Verify neither record exists in MongoDB afterward
      const persistedUser = await UserModel.findById(rolledBackUserId);
      const persistedIdentity = await AuthIdentityModel.findById(rolledBackIdentityId);

      expect(persistedUser).toBeNull();
      expect(persistedIdentity).toBeNull();
    });

    it('Transaction Conflict: executes concurrent conflicting transactions and verifies isolation', async () => {
      const UserModel = getUserModel(conn);
      const conflictEmail = `${runId}_tx_conflict@example.com`;

      const session1 = await conn.startSession();
      const session2 = await conn.startSession();

      session1.startTransaction();
      session2.startTransaction();

      let session1Result: 'COMMITTED' | 'FAILED' = 'FAILED';
      let session2Result: 'COMMITTED' | 'FAILED' = 'FAILED';
      let conflictErrorDetails: {
        code?: number;
        codeName?: string;
        errorLabels?: string[];
        message?: string;
      } | null = null;

      try {
        // Transaction 1 writes user with conflictEmail
        const [user1] = await UserModel.create(
          [
            {
              emailNormalized: conflictEmail,
              displayName: 'Tx Conflict User 1',
              role: 'CANDIDATE',
              accountStatus: 'ACTIVE',
              consentVersion: '2026-11-22.1',
            },
          ],
          { session: session1 }
        );
        createdUserIds.push(user1._id);

        // Transaction 2 attempts to write user with same unique conflictEmail concurrently
        let tx2FailedOnWrite = false;
        try {
          const [user2] = await UserModel.create(
            [
              {
                emailNormalized: conflictEmail,
                displayName: 'Tx Conflict User 2',
                role: 'CANDIDATE',
                accountStatus: 'ACTIVE',
                consentVersion: '2026-11-22.1',
              },
            ],
            { session: session2 }
          );
          createdUserIds.push(user2._id);
        } catch (err: unknown) {
          tx2FailedOnWrite = true;
          const e = err as { code?: number; codeName?: string; errorLabels?: string[]; message?: string };
          conflictErrorDetails = {
            code: e.code,
            codeName: e.codeName,
            errorLabels: e.errorLabels,
            message: e.message,
          };
          await session2.abortTransaction();
        }

        // Commit transaction 1
        await session1.commitTransaction();
        session1Result = 'COMMITTED';

        // If transaction 2 did not fail during write, attempt commit to catch conflict
        if (!tx2FailedOnWrite) {
          try {
            await session2.commitTransaction();
            session2Result = 'COMMITTED';
          } catch (err: unknown) {
            const e = err as { code?: number; codeName?: string; errorLabels?: string[]; message?: string };
            conflictErrorDetails = {
              code: e.code,
              codeName: e.codeName,
              errorLabels: e.errorLabels,
              message: e.message,
            };
            await session2.abortTransaction();
          }
        }
      } finally {
        await session1.endSession();
        await session2.endSession();
      }

      // Exactly one transaction should have succeeded; the other must have failed
      expect(session1Result).toBe('COMMITTED');
      expect(session2Result).toBe('FAILED');
      expect(conflictErrorDetails).not.toBeNull();

      // Verify documented MongoDB conflict/duplicate code (11000 duplicate key or 112 WriteConflict)
      const validConflictCodes = [11000, 112];
      expect(validConflictCodes).toContain(conflictErrorDetails?.code);

      // Verify no partial or duplicate record survived in MongoDB
      const survivingUsers = await UserModel.find({ emailNormalized: conflictEmail });
      expect(survivingUsers.length).toBe(1);
      expect(survivingUsers[0].displayName).toBe('Tx Conflict User 1');
    });
  });

  describe('Test Group D — Model-Level Negative Cases', () => {
    it('Mongoose Validation: strictly rejects invalid accountStatus enum value before database write', async () => {
      const UserModel = getUserModel(conn);

      const invalidStatusDoc = new UserModel({
        emailNormalized: `${runId}_invalid_status@example.com`,
        displayName: 'Invalid Status User',
        role: 'CANDIDATE',
        accountStatus: 'PENDING_EMAIL' as unknown as 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });

      let caughtError: unknown;
      try {
        await invalidStatusDoc.save();
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const mongooseErr = caughtError as { name: string; errors?: Record<string, { kind: string }> };
      expect(mongooseErr.name).toBe('ValidationError');
      expect(mongooseErr.errors?.accountStatus).toBeDefined();
      expect(mongooseErr.errors?.accountStatus.kind).toBe('enum');
    });

    it('MongoDB Unique Index: rejects duplicate verified identity ownership (same user, same provider)', async () => {
      const UserModel = getUserModel(conn);
      const AuthIdentityModel = getAuthIdentityModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_dup_identity_owner@example.com`,
        displayName: 'Identity Owner',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        consentVersion: '2026-11-22.1',
      });
      createdUserIds.push(user._id);

      const firstIdentity = await AuthIdentityModel.create({
        userId: user._id,
        provider: 'PASSWORD',
        subject: user.emailNormalized,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$firstHash',
      });
      createdIdentityIds.push(firstIdentity._id);

      // Mongoose schema validation will PASS (both documents are individually valid schemas),
      // but MongoDB index userId_1_provider_1 will reject with E11000
      let caughtError: unknown;
      try {
        await AuthIdentityModel.create({
          userId: user._id,
          provider: 'PASSWORD',
          subject: `${runId}_second_attempt@example.com`,
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$secondHash',
        });
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const mongoErr = caughtError as { name: string; code?: number };
      expect(mongoErr.code).toBe(11000);
    });

    it('Mongoose Validation: strictly rejects missing authenticated OTP challenge ownership (missing userId)', async () => {
      const VerificationChallengeModel = getVerificationChallengeModel(conn);

      const challengeWithoutUser = new VerificationChallengeModel({
        challengeId: `${runId}_no_user_ch`,
        purpose: 'RESET_PASSWORD',
        subjectDigest: `digest_${runId}_no_user`,
        // userId intentionally omitted
        identityVersionAtIssue: 1,
        passwordIdentityIdAtIssue: new Types.ObjectId(),
        otpDigest: 'otpDigest123',
        expiresAt: new Date(Date.now() + 300000),
      });

      let caughtError: unknown;
      try {
        await challengeWithoutUser.save();
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const mongooseErr = caughtError as { name: string; errors?: Record<string, { message: string }> };
      expect(mongooseErr.name).toBe('ValidationError');
      expect(mongooseErr.errors?.userId).toBeDefined();
      expect(mongooseErr.errors?.userId.message).toContain(
        'userId is required for RESET_PASSWORD, LINK_PASSWORD, and PHONE_VERIFY challenges'
      );
    });

    it('Mongoose Validation: strictly rejects invalid provider/password-hash combinations', async () => {
      const AuthIdentityModel = getAuthIdentityModel(conn);
      const dummyUserId = new Types.ObjectId();

      // Case A: FIREBASE_GOOGLE identity containing passwordHash
      const googleWithHash = new AuthIdentityModel({
        userId: dummyUserId,
        provider: 'FIREBASE_GOOGLE',
        subject: `google_uid_${runId}`,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$prohibitedGoogleHash',
      });

      let caughtErrorA: unknown;
      try {
        await googleWithHash.save();
      } catch (err: unknown) {
        caughtErrorA = err;
      }

      expect(caughtErrorA).toBeDefined();
      const errA = caughtErrorA as { name: string; errors?: Record<string, { message: string }> };
      expect(errA.name).toBe('ValidationError');
      expect(errA.errors?.passwordHash?.message).toContain(
        'passwordHash must be omitted for FIREBASE_GOOGLE identities'
      );

      // Case B: PASSWORD identity with missing or empty passwordHash
      const passwordWithoutHash = new AuthIdentityModel({
        userId: dummyUserId,
        provider: 'PASSWORD',
        subject: `${runId}_pwd_no_hash@example.com`,
        // passwordHash omitted
      });

      let caughtErrorB: unknown;
      try {
        await passwordWithoutHash.save();
      } catch (err: unknown) {
        caughtErrorB = err;
      }

      expect(caughtErrorB).toBeDefined();
      const errB = caughtErrorB as { name: string; errors?: Record<string, { message: string }> };
      expect(errB.name).toBe('ValidationError');
      expect(errB.errors?.passwordHash?.message).toContain(
        'passwordHash is required for PASSWORD identity'
      );
    });

    it('Mongoose Validation: strictly rejects missing recovery credential-version references', async () => {
      const VerificationChallengeModel = getVerificationChallengeModel(conn);
      const dummyUserId = new Types.ObjectId();

      // RESET_PASSWORD challenge with userId, but missing identityVersionAtIssue and passwordIdentityIdAtIssue
      const resetWithoutVersionRefs = new VerificationChallengeModel({
        challengeId: `${runId}_no_refs_ch`,
        purpose: 'RESET_PASSWORD',
        subjectDigest: `digest_${runId}_no_refs`,
        userId: dummyUserId,
        // identityVersionAtIssue and passwordIdentityIdAtIssue intentionally omitted
        otpDigest: 'otpDigest123',
        expiresAt: new Date(Date.now() + 300000),
      });

      let caughtError: unknown;
      try {
        await resetWithoutVersionRefs.save();
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const mongooseErr = caughtError as { name: string; errors?: Record<string, { message: string }> };
      expect(mongooseErr.name).toBe('ValidationError');
      expect(mongooseErr.errors?.identityVersionAtIssue).toBeDefined();
      expect(mongooseErr.errors?.identityVersionAtIssue.message).toContain(
        'identityVersionAtIssue is required for RESET_PASSWORD verification challenge'
      );
      expect(mongooseErr.errors?.passwordIdentityIdAtIssue).toBeDefined();
      expect(mongooseErr.errors?.passwordIdentityIdAtIssue.message).toContain(
        'passwordIdentityIdAtIssue is required for RESET_PASSWORD verification challenge'
      );
    });
  });

  describe('Test Group E — SessionService CAS Concurrency & Replay Invariants (P2-AUTH-05a)', () => {
    let serviceKeyring: SessionKeyring;
    let liveSessionService: SessionService;

    beforeAll(async () => {
      const config = loadEnv({
        NODE_ENV: 'test',
        MOCK_DATABASE: false,
        WEB_ORIGIN: 'http://localhost:5173',
        POLICY_ID: 'roundset-terms-privacy-2026',
        POLICY_CONSENT_VERSION: '2026-11-22',
        REGISTRATION_MODE: 'PUBLIC',
      });
      serviceKeyring = new SessionKeyring(config);
      await serviceKeyring.initialize();
      liveSessionService = new SessionService(config, serviceKeyring, conn);
    });

    it('demonstrates one successful CAS successor under concurrent SessionService.rotateSession() requests', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_srv_cas@example.test`,
        displayName: 'Service CAS User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(user._id);

      const sessionId = `${runId}_srv_cas_sess`;
      createdSessionIds.push(sessionId);

      const { rawToken: rawRefresh, digest } = createRefreshToken(serviceKeyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(serviceKeyring, { sessionId });

      const now = new Date();
      await SessionModel.create({
        sessionId,
        userId: user._id,
        status: 'ACTIVE',
        generation: 1,
        currentRefreshDigest: digest,
        epochAtIssue: 1,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      });

      // 10 concurrent calls to sessionService.rotateSession()
      const concurrency = 10;
      const rotatePromises = Array.from({ length: concurrency }, async (_, idx) => {
        try {
          const res = await liveSessionService.rotateSession({
            rawRefreshToken: rawRefresh,
            csrfHeader: csrfToken,
            csrfCookie: csrfToken,
            isSecure: false,
            requestId: `${runId}_req_${idx}`,
          });
          return { success: true, res };
        } catch (err) {
          return { success: false, err };
        }
      });

      const results = await Promise.all(rotatePromises);
      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      expect(successful.length).toBe(1);
      expect(failed.length).toBe(concurrency - 1);

      // Verify the single successor was committed to MongoDB with generation 2
      const finalSession = await SessionModel.findOne({ sessionId });
      expect(finalSession?.generation).toBe(2);
      expect(finalSession?.status).toBe('ACTIVE');
    });

    it('demonstrates forged MAC never revokes a session in real MongoDB', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_srv_forged@example.test`,
        displayName: 'Forged MAC User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(user._id);

      const sessionId = `${runId}_srv_forged_sess`;
      createdSessionIds.push(sessionId);

      const { rawToken: rawRefresh, digest } = createRefreshToken(serviceKeyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(serviceKeyring, { sessionId });

      const now = new Date();
      await SessionModel.create({
        sessionId,
        userId: user._id,
        status: 'ACTIVE',
        generation: 1,
        currentRefreshDigest: digest,
        epochAtIssue: 1,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      });

      // Tamper with MAC
      const parts = rawRefresh.split('.');
      parts[5] = 'bad_mac_' + parts[5];
      const forgedRefresh = parts.join('.');

      let caughtError: unknown;
      try {
        await liveSessionService.rotateSession({
          rawRefreshToken: forgedRefresh,
          csrfHeader: csrfToken,
          csrfCookie: csrfToken,
          isSecure: false,
          requestId: `${runId}_forged_req`,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(UnauthorizedError);

      // Session must remain completely untouched (ACTIVE, generation 1)
      const untouchedSession = await SessionModel.findOne({ sessionId });
      expect(untouchedSession?.status).toBe('ACTIVE');
      expect(untouchedSession?.generation).toBe(1);
    });

    it('demonstrates authentic stale-generation replay revokes the correct session in real MongoDB', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);
      const AuditModel = getSecurityAuditEventModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_srv_replay@example.test`,
        displayName: 'Replay Service User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(user._id);

      const sessionId = `${runId}_srv_replay_sess`;
      createdSessionIds.push(sessionId);

      // Generate a legitimate token for generation 1
      const { rawToken: staleRefresh } = createRefreshToken(serviceKeyring, {
        sessionId,
        generation: 1,
      });
      const csrfToken = createCsrfToken(serviceKeyring, { sessionId });

      const now = new Date();
      // Persistent session is already at generation 2
      await SessionModel.create({
        sessionId,
        userId: user._id,
        status: 'ACTIVE',
        generation: 2,
        currentRefreshDigest: `digest_${runId}_gen2`,
        epochAtIssue: 1,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      });

      let caughtError: unknown;
      try {
        await liveSessionService.rotateSession({
          rawRefreshToken: staleRefresh,
          csrfHeader: csrfToken,
          csrfCookie: csrfToken,
          isSecure: false,
          requestId: `${runId}_replay_req`,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(SessionReplayError);

      // Session family must be revoked in database
      const revokedSession = await SessionModel.findOne({ sessionId });
      expect(revokedSession?.status).toBe('REVOKED');
      expect(revokedSession?.revokedReason).toBe('SESSION_REPLAY_DETECTED');

      // Audit record must be persisted
      const auditRecord = await AuditModel.findOne({ targetId: sessionId });
      expect(auditRecord).toBeDefined();
      expect(auditRecord?.eventType).toBe('SESSION_REPLAY_DETECTED');
      expect(auditRecord?.outcome).toBe('FAILURE');
    });

    it('demonstrates revoked-session logout-all is rejected in real MongoDB', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_srv_revoked_logout@example.test`,
        displayName: 'Revoked Logout User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(user._id);

      const sessionId = `${runId}_srv_revoked_logout_sess`;
      createdSessionIds.push(sessionId);

      const now = new Date();
      // Session is already REVOKED
      await SessionModel.create({
        sessionId,
        userId: user._id,
        status: 'REVOKED',
        generation: 1,
        epochAtIssue: 1,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      });

      // Bearer token issued for this now-revoked session
      const bearerToken = await signAccessToken(serviceKeyring, {
        userId: String(user._id),
        sessionId,
        epoch: 1,
      });

      let caughtError: unknown;
      try {
        await liveSessionService.logoutAll({
          bearerToken,
          requestId: `${runId}_revoked_logout_all_req`,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(UnauthorizedError);

      // User sessionEpoch must NOT have been incremented
      const freshUser = await UserModel.findById(user._id);
      expect(freshUser?.sessionEpoch).toBe(1);
    });

    it('demonstrates atomic global logout-all commit and concurrent CAS isolation in real MongoDB', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_srv_atomic_logout@example.test`,
        displayName: 'Atomic Logout User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(user._id);

      const sessId1 = `${runId}_srv_atomic_s1`;
      const sessId2 = `${runId}_srv_atomic_s2`;
      createdSessionIds.push(sessId1, sessId2);

      const now = new Date();
      await SessionModel.create([
        {
          sessionId: sessId1,
          userId: user._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
        {
          sessionId: sessId2,
          userId: user._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
      ]);

      const bearerToken = await signAccessToken(serviceKeyring, {
        userId: String(user._id),
        sessionId: sessId1,
        epoch: 1,
      });

      // Concurrent logout-all execution
      const [res1, res2] = await Promise.allSettled([
        liveSessionService.logoutAll({ bearerToken, requestId: `${runId}_atomic_req1` }),
        liveSessionService.logoutAll({ bearerToken, requestId: `${runId}_atomic_req2` }),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      // Exactly one succeeds, the other gets 401 CAS conflict
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Verify user sessionEpoch was bumped exactly once
      const finalUser = await UserModel.findById(user._id);
      expect(finalUser?.sessionEpoch).toBe(2);

      // Verify both active sessions were revoked atomically
      const s1 = await SessionModel.findOne({ sessionId: sessId1 });
      const s2 = await SessionModel.findOne({ sessionId: sessId2 });
      expect(s1?.status).toBe('REVOKED');
      expect(s2?.status).toBe('REVOKED');
      expect(s1?.revokedReason).toBe('LOGOUT_ALL');
      expect(s2?.revokedReason).toBe('LOGOUT_ALL');
    });

    it('demonstrates race where single-session logout wins before logout-all session fence in real MongoDB', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_srv_single_wins@example.test`,
        displayName: 'Single Wins User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(user._id);

      const sessId1 = `${runId}_srv_sw_s1`;
      const sessId2 = `${runId}_srv_sw_s2`;
      createdSessionIds.push(sessId1, sessId2);

      const now = new Date();
      await SessionModel.create([
        {
          sessionId: sessId1,
          userId: user._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
        {
          sessionId: sessId2,
          userId: user._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
      ]);

      const bearerToken = await signAccessToken(serviceKeyring, {
        userId: String(user._id),
        sessionId: sessId1,
        epoch: 1,
      });

      // 1. Single-session logout wins first: revokes sessId1
      await liveSessionService.logout({
        bearerToken,
        requestId: `${runId}_single_logout_req`,
      });

      const s1AfterSingle = await SessionModel.findOne({ sessionId: sessId1 });
      expect(s1AfterSingle?.status).toBe('REVOKED');
      expect(s1AfterSingle?.revokedReason).toBe('USER_LOGOUT');

      // 2. Logout-all attempts to run using the now-revoked session
      let caughtError: unknown;
      try {
        await liveSessionService.logoutAll({
          bearerToken,
          requestId: `${runId}_logout_all_after_single_req`,
        });
      } catch (err) {
        caughtError = err;
      }

      // Must be rejected with UnauthorizedError
      expect(caughtError).toBeInstanceOf(UnauthorizedError);

      // User sessionEpoch must NOT have been incremented
      const freshUser = await UserModel.findById(user._id);
      expect(freshUser?.sessionEpoch).toBe(1);

      // Session 2 must remain ACTIVE
      const s2After = await SessionModel.findOne({ sessionId: sessId2 });
      expect(s2After?.status).toBe('ACTIVE');
    });

    it('demonstrates race where logout-all wins before single-session logout in real MongoDB', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_srv_all_wins@example.test`,
        displayName: 'All Wins User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(user._id);

      const sessId1 = `${runId}_srv_aw_s1`;
      const sessId2 = `${runId}_srv_aw_s2`;
      createdSessionIds.push(sessId1, sessId2);

      const now = new Date();
      await SessionModel.create([
        {
          sessionId: sessId1,
          userId: user._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
        {
          sessionId: sessId2,
          userId: user._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
      ]);

      const bearerToken = await signAccessToken(serviceKeyring, {
        userId: String(user._id),
        sessionId: sessId1,
        epoch: 1,
      });

      // 1. Logout-all wins first: fences sessId1, bumps epoch to 2, revokes sessId1 and sessId2
      await liveSessionService.logoutAll({
        bearerToken,
        requestId: `${runId}_all_wins_req`,
      });

      const freshUser = await UserModel.findById(user._id);
      expect(freshUser?.sessionEpoch).toBe(2);

      const s1After = await SessionModel.findOne({ sessionId: sessId1 });
      const s2After = await SessionModel.findOne({ sessionId: sessId2 });
      expect(s1After?.status).toBe('REVOKED');
      expect(s2After?.status).toBe('REVOKED');
      expect(s1After?.revokedReason).toBe('LOGOUT_ALL');
      expect(s2After?.revokedReason).toBe('LOGOUT_ALL');

      // 2. Subsequent single-session logout runs: completes cleanly without crashing or changing epoch
      await liveSessionService.logout({
        bearerToken,
        requestId: `${runId}_single_after_all_req`,
      });

      const userAfter = await UserModel.findById(user._id);
      expect(userAfter?.sessionEpoch).toBe(2);

      // Terminal revocation reason LOGOUT_ALL must NOT be overwritten by single-session logout
      const s1FinalAfter = await SessionModel.findOne({ sessionId: sessId1 });
      expect(s1FinalAfter?.status).toBe('REVOKED');
      expect(s1FinalAfter?.revokedReason).toBe('LOGOUT_ALL');
    });

    it('demonstrates genuinely overlapping concurrent race between single-session logout and logout-all in real MongoDB', async () => {
      const UserModel = getUserModel(conn);
      const SessionModel = getSessionModel(conn);

      const user = await UserModel.create({
        emailNormalized: `${runId}_srv_overlap_race@example.test`,
        displayName: 'Overlapping Race User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(user._id);

      const sessId1 = `${runId}_srv_ol_s1`;
      const sessId2 = `${runId}_srv_ol_s2`;
      createdSessionIds.push(sessId1, sessId2);

      // Foreign user to verify isolation: foreign session must never be modified
      const foreignUser = await UserModel.create({
        emailNormalized: `${runId}_srv_foreign_isolation@example.test`,
        displayName: 'Foreign Isolation User',
        role: 'CANDIDATE',
        accountStatus: 'ACTIVE',
        sessionEpoch: 1,
        identityVersion: 1,
        consentVersion: '2026-11-22',
        consentAt: new Date(),
      });
      createdUserIds.push(foreignUser._id);

      const foreignSessId = `${runId}_srv_foreign_s1`;
      createdSessionIds.push(foreignSessId);

      const now = new Date();
      await SessionModel.create([
        {
          sessionId: sessId1,
          userId: user._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
        {
          sessionId: sessId2,
          userId: user._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
        {
          sessionId: foreignSessId,
          userId: foreignUser._id,
          status: 'ACTIVE',
          generation: 1,
          epochAtIssue: 1,
          createdAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
      ]);

      const bearerToken = await signAccessToken(serviceKeyring, {
        userId: String(user._id),
        sessionId: sessId1,
        epoch: 1,
      });

      // Genuinely overlapping concurrent dispatch of single-session logout and logout-all
      const [_resSingle, resAll] = await Promise.allSettled([
        liveSessionService.logout({
          bearerToken,
          requestId: `${runId}_ol_single_req`,
        }),
        liveSessionService.logoutAll({
          bearerToken,
          requestId: `${runId}_ol_all_req`,
        }),
      ]);

      // The targeted session sessId1 MUST be revoked in all cases
      const s1Final = await SessionModel.findOne({ sessionId: sessId1 });
      expect(s1Final?.status).toBe('REVOKED');
      expect(['LOGOUT_ALL', 'USER_LOGOUT']).toContain(s1Final?.revokedReason);

      const freshUser = await UserModel.findById(user._id);
      // Epoch must either be 1 (single logout won) or 2 (logout-all won), never corrupted or duplicated (>2)
      expect([1, 2]).toContain(freshUser?.sessionEpoch);

      if (resAll.status === 'fulfilled') {
        // If logout-all won, exactly one global epoch increment occurred
        expect(freshUser?.sessionEpoch).toBe(2);
        const s2Final = await SessionModel.findOne({ sessionId: sessId2 });
        expect(s2Final?.status).toBe('REVOKED');
        expect(s2Final?.revokedReason).toBe('LOGOUT_ALL');
      } else {
        // If single logout won before logout-all's fence, or MongoDB raised a write-conflict:
        // Epoch must NOT be incremented
        expect(freshUser?.sessionEpoch).toBe(1);
        const s2Final = await SessionModel.findOne({ sessionId: sessId2 });
        // Unrelated session s2 must remain ACTIVE
        expect(s2Final?.status).toBe('ACTIVE');

        // Documented error classification check: must NEVER silently accept arbitrary database errors
        const err = resAll.reason;
        const isUnauthorized = err instanceof UnauthorizedError;
        const isWriteConflict =
          err &&
          typeof err === 'object' &&
          ((err as { code?: unknown }).code === 112 ||
            (err as { codeName?: unknown }).codeName === 'WriteConflict' ||
            (typeof (err as { hasErrorLabel?: unknown }).hasErrorLabel === 'function' &&
              (err as { hasErrorLabel: (l: string) => boolean }).hasErrorLabel('TransientTransactionError')) ||
            (Array.isArray((err as { errorLabels?: unknown }).errorLabels) &&
              (err as { errorLabels: string[] }).errorLabels.includes('TransientTransactionError')) ||
            (typeof (err as { message?: unknown }).message === 'string' &&
              (err as { message: string }).message.includes('WriteConflict')));

        expect(isUnauthorized || isWriteConflict).toBe(true);
      }

      // Foreign user and foreign session must NEVER be modified regardless of race scheduling
      const freshForeignUser = await UserModel.findById(foreignUser._id);
      expect(freshForeignUser?.sessionEpoch).toBe(1);
      const foreignSessionFinal = await SessionModel.findOne({ sessionId: foreignSessId });
      expect(foreignSessionFinal?.status).toBe('ACTIVE');
    });
  });
});
