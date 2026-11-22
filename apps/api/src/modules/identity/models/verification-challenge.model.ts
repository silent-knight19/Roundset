import mongoose, { Schema, HydratedDocument, Model, Connection, Types } from 'mongoose';

export interface IVerificationChallenge {
  challengeId: string;
  purpose: 'RESET_PASSWORD' | 'LINK_PASSWORD' | 'PHONE_VERIFY';
  subjectDigest: string;
  userId?: Types.ObjectId;
  identityVersionAtIssue?: number;
  passwordIdentityIdAtIssue?: Types.ObjectId;
  sessionId?: string;
  reauthTicketDigest?: string;
  otpDigest: string;
  generation: number;
  attempts: number;
  resendCount: number;
  state: 'ISSUED' | 'CONSUMED' | 'INVALIDATED';
  deliveryState: 'PENDING' | 'ACCEPTED' | 'FAILED';
  expiresAt: Date;
  createdAt: Date;
  consumedAt?: Date;
}

export type VerificationChallengeDocument = HydratedDocument<IVerificationChallenge>;

export const VerificationChallengeSchema = new Schema<IVerificationChallenge>(
  {
    challengeId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    purpose: {
      type: String,
      required: true,
      enum: ['RESET_PASSWORD', 'LINK_PASSWORD', 'PHONE_VERIFY'],
    },
    subjectDigest: {
      type: String,
      required: true,
      trim: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [
        function (this: IVerificationChallenge) {
          return this.purpose === 'RESET_PASSWORD';
        },
        'userId is required for RESET_PASSWORD verification challenge',
      ],
    },
    identityVersionAtIssue: {
      type: Number,
      min: 1,
      required: [
        function (this: IVerificationChallenge) {
          return this.purpose === 'RESET_PASSWORD';
        },
        'identityVersionAtIssue is required for RESET_PASSWORD verification challenge',
      ],
    },
    passwordIdentityIdAtIssue: {
      type: Schema.Types.ObjectId,
      ref: 'AuthIdentity',
      required: [
        function (this: IVerificationChallenge) {
          return this.purpose === 'RESET_PASSWORD';
        },
        'passwordIdentityIdAtIssue is required for RESET_PASSWORD verification challenge',
      ],
    },
    sessionId: {
      type: String,
      trim: true,
    },
    reauthTicketDigest: {
      type: String,
      trim: true,
    },
    otpDigest: {
      type: String,
      required: true,
      trim: true,
    },
    generation: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
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
      enum: ['ISSUED', 'CONSUMED', 'INVALIDATED'],
      default: 'ISSUED',
    },
    deliveryState: {
      type: String,
      required: true,
      enum: ['PENDING', 'ACCEPTED', 'FAILED'],
      default: 'PENDING',
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    consumedAt: {
      type: Date,
    },
  },
  {
    collection: 'verificationChallenges',
    timestamps: false,
    strict: 'throw',
  }
);

// Critical indexes defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({purpose: 1, subjectDigest: 1})
// unique({challengeId: 1})
// TTL({expiresAt: 1}, expireAfterSeconds: 0)
VerificationChallengeSchema.index({ purpose: 1, subjectDigest: 1 }, { unique: true });
VerificationChallengeSchema.index({ challengeId: 1 }, { unique: true });
VerificationChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export function getVerificationChallengeModel(
  conn: Connection = mongoose.connection
): Model<IVerificationChallenge> {
  return (
    (conn.models.VerificationChallenge as Model<IVerificationChallenge>) ||
    conn.model<IVerificationChallenge>('VerificationChallenge', VerificationChallengeSchema)
  );
}

export const VerificationChallengeModel = getVerificationChallengeModel(mongoose.connection);
