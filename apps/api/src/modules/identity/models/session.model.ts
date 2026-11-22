import mongoose, { Schema, HydratedDocument, Model, Connection, Types } from 'mongoose';

export interface ISession {
  sessionId: string;
  userId: Types.ObjectId;
  status: 'ACTIVE' | 'REVOKED' | 'COMPROMISED' | 'EXPIRED';
  generation: number;
  currentRefreshDigest?: string;
  epochAtIssue: number;
  createdAt: Date;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  approxDeviceLabel?: string;
  revokedAt?: Date;
  revokedReason?: string;
}

export type SessionDocument = HydratedDocument<ISession>;

export const SessionSchema = new Schema<ISession>(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['ACTIVE', 'REVOKED', 'COMPROMISED', 'EXPIRED'],
      default: 'ACTIVE',
    },
    generation: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    currentRefreshDigest: {
      type: String,
      trim: true,
    },
    epochAtIssue: {
      type: Number,
      required: true,
      min: 1,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lastUsedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    idleExpiresAt: {
      type: Date,
      required: true,
    },
    absoluteExpiresAt: {
      type: Date,
      required: true,
    },
    approxDeviceLabel: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    revokedAt: {
      type: Date,
    },
    revokedReason: {
      type: String,
      trim: true,
      maxlength: 256,
    },
  },
  {
    collection: 'sessions',
    timestamps: false,
    strict: 'throw',
  }
);

// Critical indexes defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({sessionId: 1})
// unique({currentRefreshDigest: 1}, partialFilterExpression: {status: 'ACTIVE', currentRefreshDigest: {$type: 'string'}})
// index({userId: 1, status: 1, lastUsedAt: -1})
// TTL({absoluteExpiresAt: 1}, expireAfterSeconds: 0)
SessionSchema.index({ sessionId: 1 }, { unique: true });

SessionSchema.index(
  { currentRefreshDigest: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: 'ACTIVE',
      currentRefreshDigest: { $type: 'string' },
    },
  }
);

SessionSchema.index({ userId: 1, status: 1, lastUsedAt: -1 });
SessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

export function getSessionModel(conn: Connection = mongoose.connection): Model<ISession> {
  return (
    (conn.models.Session as Model<ISession>) ||
    conn.model<ISession>('Session', SessionSchema)
  );
}

export const SessionModel = getSessionModel(mongoose.connection);
