import mongoose, { Schema, HydratedDocument, Model, Connection, Types } from 'mongoose';

export interface IUserPreferences {
  language?: 'en';
  reducedMotion?: boolean;
  timezone?: string;
}

export interface IUser {
  _id: Types.ObjectId;
  emailNormalized?: string;
  emailVerifiedAt?: Date | null;
  displayName: string;
  role: 'CANDIDATE' | 'ADMIN';
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION' | 'DELETED';
  sessionEpoch: number;
  identityVersion: number;
  preferences: IUserPreferences;
  consentVersion: string;
  consentAt: Date;
  phoneE164?: string;
  phoneVerifiedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type UserDocument = HydratedDocument<IUser>;

const UserPreferencesSubSchema = new Schema<IUserPreferences>(
  {
    language: {
      type: String,
      enum: ['en'],
      default: 'en',
    },
    reducedMotion: {
      type: Boolean,
      default: false,
    },
    timezone: {
      type: String,
      default: 'UTC',
      maxlength: 64,
    },
  },
  { _id: false, strict: 'throw' }
);

export const UserSchema = new Schema<IUser>(
  {
    emailNormalized: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    emailVerifiedAt: {
      type: Date,
      default: null,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    role: {
      type: String,
      required: true,
      enum: ['CANDIDATE', 'ADMIN'],
      default: 'CANDIDATE',
    },
    accountStatus: {
      type: String,
      required: true,
      enum: ['ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED'],
      default: 'ACTIVE',
    },
    sessionEpoch: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    identityVersion: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    preferences: {
      type: UserPreferencesSubSchema,
      default: () => ({ language: 'en', reducedMotion: false, timezone: 'UTC' }),
    },
    consentVersion: {
      type: String,
      required: true,
      trim: true,
    },
    consentAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    phoneE164: {
      type: String,
      trim: true,
    },
    phoneVerifiedAt: {
      type: Date,
      default: null,
    },
  },
  {
    collection: 'users',
    timestamps: true,
    strict: 'throw',
  }
);

// Critical indexes defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({emailNormalized: 1}, partialFilterExpression: {emailNormalized: {$type: 'string'}})
// unique({phoneE164: 1}, partialFilterExpression: {phoneE164: {$type: 'string'}})
// index({accountStatus: 1, createdAt: 1})
UserSchema.index(
  { emailNormalized: 1 },
  {
    unique: true,
    partialFilterExpression: { emailNormalized: { $type: 'string' } },
  }
);

UserSchema.index(
  { phoneE164: 1 },
  {
    unique: true,
    partialFilterExpression: { phoneE164: { $type: 'string' } },
  }
);

UserSchema.index({ accountStatus: 1, createdAt: 1 });

export function getUserModel(conn: Connection = mongoose.connection): Model<IUser> {
  return (
    (conn.models.User as Model<IUser>) ||
    conn.model<IUser>('User', UserSchema)
  );
}

export const UserModel = getUserModel(mongoose.connection);
