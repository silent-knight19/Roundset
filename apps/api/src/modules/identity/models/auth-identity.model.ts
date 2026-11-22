import mongoose, { Schema, HydratedDocument, Model, Connection, Types } from 'mongoose';

export interface IAuthIdentity {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  provider: 'PASSWORD' | 'FIREBASE_GOOGLE';
  subject: string;
  passwordHash?: string;
  linkedAt: Date;
  lastUsedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type AuthIdentityDocument = HydratedDocument<IAuthIdentity>;

export const AuthIdentitySchema = new Schema<IAuthIdentity>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    provider: {
      type: String,
      required: true,
      enum: ['PASSWORD', 'FIREBASE_GOOGLE'],
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    passwordHash: {
      type: String,
    },
    linkedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lastUsedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    collection: 'authIdentities',
    timestamps: true,
    strict: 'throw',
  }
);

// Critical indexes defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({provider: 1, subject: 1})
// unique({userId: 1, provider: 1})
// index({userId: 1})
AuthIdentitySchema.index({ provider: 1, subject: 1 }, { unique: true });
AuthIdentitySchema.index({ userId: 1, provider: 1 }, { unique: true });
AuthIdentitySchema.index({ userId: 1 });

export function getAuthIdentityModel(conn: Connection = mongoose.connection): Model<IAuthIdentity> {
  return (
    (conn.models.AuthIdentity as Model<IAuthIdentity>) ||
    conn.model<IAuthIdentity>('AuthIdentity', AuthIdentitySchema)
  );
}

export const AuthIdentityModel = getAuthIdentityModel(mongoose.connection);
