import { Connection, Types } from 'mongoose';
import {
  getUserModel,
  getAuthIdentityModel,
  getSessionModel,
  getVerificationChallengeModel,
} from '../src/modules/identity/models/index.js';

export const EXPECTED_TEST_DB_NAME = 'roundset_test';

/**
 * Extracts database name from MongoDB URI string.
 */
export function extractDatabaseName(uri: string): string {
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    return parsed.pathname.replace(/^\/|\/$/g, '');
  } catch {
    const match = uri.match(/\/([^/?]+)(\?|$)/);
    return match ? match[1].replace(/\/$/, '') : '';
  }
}

/**
 * Validates that the database name in MONGODB_TEST_URI matches roundset_test exactly.
 * Rejects substring matches (e.g. "test", "roundset_testing", "my_test") and production/app databases.
 */
export function validateIntegrationDatabaseName(uri: string): string {
  const dbName = extractDatabaseName(uri);
  if (dbName !== EXPECTED_TEST_DB_NAME) {
    throw new Error(
      `Execution refused: Target database "${dbName}" is not authorized for integration tests. ` +
        `The database name in MONGODB_TEST_URI must exactly match "${EXPECTED_TEST_DB_NAME}" to protect production and application data.`
    );
  }
  return dbName;
}

export interface CleanupEntities {
  createdUserIds?: Types.ObjectId[];
  createdIdentityIds?: Types.ObjectId[];
  createdSessionIds?: string[];
  createdChallengeIds?: string[];
  runId?: string;
}

export interface CleanupResult {
  deletedUsers: number;
  deletedIdentities: number;
  deletedSessions: number;
  deletedChallenges: number;
}

/**
 * Deletes synthetic records created during integration tests and verifies
 * that zero synthetic records remain in the test database.
 * Throws if cleanup fails or if any synthetic record remains.
 */
export async function performHarnessCleanup(
  conn: Connection,
  entities: CleanupEntities
): Promise<CleanupResult> {
  const UserModel = getUserModel(conn);
  const AuthIdentityModel = getAuthIdentityModel(conn);
  const SessionModel = getSessionModel(conn);
  const VerificationChallengeModel = getVerificationChallengeModel(conn);

  const userIds = entities.createdUserIds || [];
  const identityIds = entities.createdIdentityIds || [];
  const sessionIds = entities.createdSessionIds || [];
  const challengeIds = entities.createdChallengeIds || [];
  const runId = entities.runId;

  const userFilter: Record<string, unknown>[] = [];
  if (userIds.length > 0) userFilter.push({ _id: { $in: userIds } });
  if (runId) userFilter.push({ emailNormalized: new RegExp(`^${runId}_`) });

  const identityFilter: Record<string, unknown>[] = [];
  if (identityIds.length > 0) identityFilter.push({ _id: { $in: identityIds } });
  if (userIds.length > 0) identityFilter.push({ userId: { $in: userIds } });
  if (runId) identityFilter.push({ subject: new RegExp(`^${runId}_`) });

  const sessionFilter: Record<string, unknown>[] = [];
  if (sessionIds.length > 0) sessionFilter.push({ sessionId: { $in: sessionIds } });
  if (runId) sessionFilter.push({ sessionId: new RegExp(`^${runId}_`) });

  const challengeFilter: Record<string, unknown>[] = [];
  if (challengeIds.length > 0) challengeFilter.push({ challengeId: { $in: challengeIds } });
  if (runId) challengeFilter.push({ challengeId: new RegExp(`^${runId}_`) });

  // 1. Execute deletions
  const userDeleteRes =
    userFilter.length > 0
      ? await UserModel.deleteMany({ $or: userFilter })
      : { deletedCount: 0 };

  const identityDeleteRes =
    identityFilter.length > 0
      ? await AuthIdentityModel.deleteMany({ $or: identityFilter })
      : { deletedCount: 0 };

  const sessionDeleteRes =
    sessionFilter.length > 0
      ? await SessionModel.deleteMany({ $or: sessionFilter })
      : { deletedCount: 0 };

  const challengeDeleteRes =
    challengeFilter.length > 0
      ? await VerificationChallengeModel.deleteMany({ $or: challengeFilter })
      : { deletedCount: 0 };

  // 2. Verification step: ensure zero synthetic records remain
  const remainingUsers =
    userFilter.length > 0
      ? await UserModel.countDocuments({ $or: userFilter })
      : 0;

  const remainingIdentities =
    identityFilter.length > 0
      ? await AuthIdentityModel.countDocuments({ $or: identityFilter })
      : 0;

  const remainingSessions =
    sessionFilter.length > 0
      ? await SessionModel.countDocuments({ $or: sessionFilter })
      : 0;

  const remainingChallenges =
    challengeFilter.length > 0
      ? await VerificationChallengeModel.countDocuments({ $or: challengeFilter })
      : 0;

  if (
    remainingUsers > 0 ||
    remainingIdentities > 0 ||
    remainingSessions > 0 ||
    remainingChallenges > 0
  ) {
    throw new Error(
      `Cleanup verification failed: Synthetic records still present in ${EXPECTED_TEST_DB_NAME} database. ` +
        `Remaining: users=${remainingUsers}, identities=${remainingIdentities}, sessions=${remainingSessions}, challenges=${remainingChallenges}`
    );
  }

  return {
    deletedUsers: userDeleteRes.deletedCount ?? 0,
    deletedIdentities: identityDeleteRes.deletedCount ?? 0,
    deletedSessions: sessionDeleteRes.deletedCount ?? 0,
    deletedChallenges: challengeDeleteRes.deletedCount ?? 0,
  };
}

/**
 * Ensures cleanup errors are rethrown (never silently swallowed)
 * while guaranteeing that conn.close() is ALWAYS called.
 */
export async function executeGuaranteedCleanup(
  conn: Connection,
  cleanupFn: () => Promise<unknown>
): Promise<void> {
  let cleanupError: unknown = null;
  try {
    await cleanupFn();
  } catch (err: unknown) {
    cleanupError = err;
  } finally {
    await conn.close();
  }

  if (cleanupError) {
    throw cleanupError;
  }
}
