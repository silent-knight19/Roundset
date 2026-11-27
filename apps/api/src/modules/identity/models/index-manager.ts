import { Connection, Model } from 'mongoose';
import { getPendingRegistrationModel } from './pending-registration.model.js';
import { getUserModel } from './user.model.js';
import { getAuthIdentityModel } from './auth-identity.model.js';
import { getSessionModel } from './session.model.js';
import { getVerificationChallengeModel } from './verification-challenge.model.js';
import { getReauthTicketModel } from './reauth-ticket.model.js';
import { getAuthRateLimitModel } from './auth-rate-limit.model.js';
import { getEmailSendBudgetModel } from './email-send-budget.model.js';
import { getSecurityAuditEventModel } from './security-audit-event.model.js';
import { getRegistrationAllowlistModel } from './registration-allowlist.model.js';

export interface ExpectedIndexSpec {
  key: Record<string, number | string>;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
  name?: string;
}

export interface CollectionIndexRequirement {
  collectionName: string;
  modelGetter: (conn: Connection) => Model<unknown>;
  criticalIndexes: ExpectedIndexSpec[];
}

export const REQUIRED_IDENTITY_INDEXES: CollectionIndexRequirement[] = [
  {
    collectionName: 'pendingRegistrations',
    modelGetter: getPendingRegistrationModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [
      { key: { registrationId: 1 }, unique: true },
      { key: { emailNormalized: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  },
  {
    collectionName: 'users',
    modelGetter: getUserModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [
      {
        key: { emailNormalized: 1 },
        unique: true,
        partialFilterExpression: { emailNormalized: { $type: 'string' } },
      },
      {
        key: { phoneE164: 1 },
        unique: true,
        partialFilterExpression: { phoneE164: { $type: 'string' } },
      },
      { key: { accountStatus: 1, createdAt: 1 } },
    ],
  },
  {
    collectionName: 'authIdentities',
    modelGetter: getAuthIdentityModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [
      { key: { provider: 1, subject: 1 }, unique: true },
      { key: { userId: 1, provider: 1 }, unique: true },
      { key: { userId: 1 } },
    ],
  },
  {
    collectionName: 'sessions',
    modelGetter: getSessionModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [
      { key: { sessionId: 1 }, unique: true },
      {
        key: { currentRefreshDigest: 1 },
        unique: true,
        partialFilterExpression: {
          status: 'ACTIVE',
          currentRefreshDigest: { $type: 'string' },
        },
      },
      { key: { userId: 1, status: 1, lastUsedAt: -1 } },
      { key: { absoluteExpiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  },
  {
    collectionName: 'verificationChallenges',
    modelGetter: getVerificationChallengeModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [
      { key: { purpose: 1, subjectDigest: 1 }, unique: true },
      { key: { challengeId: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  },
  {
    collectionName: 'reauthTickets',
    modelGetter: getReauthTicketModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [
      { key: { ticketDigest: 1 }, unique: true },
      { key: { userId: 1, sessionId: 1, action: 1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  },
  {
    collectionName: 'authRateLimits',
    modelGetter: getAuthRateLimitModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [
      { key: { bucketKey: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
  },
  {
    collectionName: 'emailSendBudget',
    modelGetter: getEmailSendBudgetModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [{ key: { dateKey: 1 }, unique: true }],
  },
  {
    collectionName: 'securityAuditEvents',
    modelGetter: getSecurityAuditEventModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [
      { key: { eventId: 1 }, unique: true },
      { key: { targetId: 1, at: -1 } },
      { key: { at: -1 } },
    ],
  },
  {
    collectionName: 'registrationAllowlist',
    modelGetter: getRegistrationAllowlistModel as (conn: Connection) => Model<unknown>,
    criticalIndexes: [{ key: { emailNormalized: 1 }, unique: true }],
  },
];

export async function ensureIdentityIndexes(conn: Connection): Promise<void> {
  for (const item of REQUIRED_IDENTITY_INDEXES) {
    const model = item.modelGetter(conn);
    await model.createIndexes();
  }
}

export function matchesKey(
  actualKey: Record<string, unknown>,
  expectedKey: Record<string, unknown>
): boolean {
  const actualEntries = Object.entries(actualKey);
  const expectedEntries = Object.entries(expectedKey);
  if (actualEntries.length !== expectedEntries.length) return false;
  return expectedEntries.every(([k, v], i) => actualEntries[i]?.[0] === k && actualEntries[i]?.[1] === v);
}

export interface RawMongoIndex {
  key: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
  name?: string;
  sparse?: boolean;
  collation?: { locale?: string };
  [extra: string]: unknown;
}

export async function verifyIdentityIndexes(conn: Connection): Promise<{
  ok: boolean;
  issues: string[];
  details: Record<string, RawMongoIndex[]>;
}> {
  const issues: string[] = [];
  const details: Record<string, RawMongoIndex[]> = {};

  for (const req of REQUIRED_IDENTITY_INDEXES) {
    const model = req.modelGetter(conn);
    let actualIndexes: RawMongoIndex[] = [];

    try {
      actualIndexes = (await model.collection.indexes()) as RawMongoIndex[];
      details[req.collectionName] = actualIndexes;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`Collection ${req.collectionName} failed to read indexes: ${msg}`);
      continue;
    }

    for (const expected of req.criticalIndexes) {
      const candidates = actualIndexes.filter(idx => matchesKey(idx.key, expected.key));
      if (!candidates.length) {
        issues.push(`Collection ${req.collectionName} missing required index: ${JSON.stringify(expected.key)}`);
        continue;
      }
      if (!candidates.some(idx =>
        Boolean(idx.unique) === Boolean(expected.unique) &&
        !idx.sparse &&
        (!idx.collation || idx.collation.locale === 'simple') &&
        idx.expireAfterSeconds === expected.expireAfterSeconds &&
        JSON.stringify(idx.partialFilterExpression) === JSON.stringify(expected.partialFilterExpression)
      )) {
        issues.push(`Collection ${req.collectionName} index options mismatch: ${JSON.stringify(expected.key)}`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    details,
  };
}
