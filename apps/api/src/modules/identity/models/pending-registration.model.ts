import mongoose, { Schema, HydratedDocument, Model, Connection } from 'mongoose';

export interface IPendingRegistration {
  registrationId: string;
  emailNormalized: string;
  passwordHash: string;
  nonceDigest: string;
  otpDigest: string;
  version: number;
  attempts: number;
  resendCount: number;
  state: 'PENDING_DELIVERY' | 'SENT' | 'CONSUMED';
  deliveryState: 'PENDING' | 'ACCEPTED' | 'FAILED';
  otpExpiresAt: Date;
  expiresAt: Date;
  consentVersion: string;
  displayName?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type PendingRegistrationDocument = HydratedDocument<IPendingRegistration>;

export const PendingRegistrationSchema = new Schema<IPendingRegistration>(
  {
    registrationId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    emailNormalized: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    nonceDigest: {
      type: String,
      required: true,
    },
    otpDigest: {
      type: String,
      required: true,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    resendCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    state: {
      type: String,
      required: true,
      enum: ['PENDING_DELIVERY', 'SENT', 'CONSUMED'],
      default: 'PENDING_DELIVERY',
    },
    deliveryState: {
      type: String,
      required: true,
      enum: ['PENDING', 'ACCEPTED', 'FAILED'],
      default: 'PENDING',
    },
    otpExpiresAt: {
      type: Date,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    consentVersion: {
      type: String,
      required: true,
      trim: true,
    },
    displayName: {
      type: String,
      trim: true,
    },
  },
  {
    collection: 'pendingRegistrations',
    timestamps: true,
    strict: 'throw',
  }
);

// Critical indexes defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({registrationId: 1}); unique({emailNormalized: 1}); TTL({expiresAt: 1}, expireAfterSeconds: 0)
PendingRegistrationSchema.index({ registrationId: 1 }, { unique: true });
PendingRegistrationSchema.index({ emailNormalized: 1 }, { unique: true });
PendingRegistrationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export function getPendingRegistrationModel(
  conn: Connection = mongoose.connection
): Model<IPendingRegistration> {
  return (
    (conn.models.PendingRegistration as Model<IPendingRegistration>) ||
    conn.model<IPendingRegistration>('PendingRegistration', PendingRegistrationSchema)
  );
}

export const PendingRegistrationModel = getPendingRegistrationModel(mongoose.connection);
