import mongoose, { Schema, HydratedDocument, Model, Connection } from 'mongoose';

export interface IAuthRateLimit {
  bucketKey: string;
  count: number;
  windowEnd: Date;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type AuthRateLimitDocument = HydratedDocument<IAuthRateLimit>;

export const AuthRateLimitSchema = new Schema<IAuthRateLimit>(
  {
    bucketKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    count: {
      type: Number,
      required: true,
      default: 1,
      min: 0,
    },
    windowEnd: {
      type: Date,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    collection: 'authRateLimits',
    timestamps: true,
    strict: 'throw',
  }
);

// Critical indexes defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({bucketKey: 1})
// TTL({expiresAt: 1}, expireAfterSeconds: 0)
AuthRateLimitSchema.index({ bucketKey: 1 }, { unique: true });
AuthRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export function getAuthRateLimitModel(conn: Connection = mongoose.connection): Model<IAuthRateLimit> {
  return (
    (conn.models.AuthRateLimit as Model<IAuthRateLimit>) ||
    conn.model<IAuthRateLimit>('AuthRateLimit', AuthRateLimitSchema)
  );
}

export const AuthRateLimitModel = getAuthRateLimitModel(mongoose.connection);
