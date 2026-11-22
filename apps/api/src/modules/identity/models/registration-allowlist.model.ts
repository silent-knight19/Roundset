import mongoose, { Schema, HydratedDocument, Model, Connection, Types } from 'mongoose';

export interface IRegistrationAllowlist {
  emailNormalized: string;
  expiresAt?: Date;
  redeemedBy?: Types.ObjectId;
  redeemedAt?: Date;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type RegistrationAllowlistDocument = HydratedDocument<IRegistrationAllowlist>;

export const RegistrationAllowlistSchema = new Schema<IRegistrationAllowlist>(
  {
    emailNormalized: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    expiresAt: {
      type: Date,
    },
    redeemedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    redeemedAt: {
      type: Date,
    },
    createdBy: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    collection: 'registrationAllowlist',
    timestamps: true,
    strict: 'throw',
  }
);

// Critical index defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({emailNormalized: 1})
RegistrationAllowlistSchema.index({ emailNormalized: 1 }, { unique: true });

export function getRegistrationAllowlistModel(
  conn: Connection = mongoose.connection
): Model<IRegistrationAllowlist> {
  return (
    (conn.models.RegistrationAllowlist as Model<IRegistrationAllowlist>) ||
    conn.model<IRegistrationAllowlist>('RegistrationAllowlist', RegistrationAllowlistSchema)
  );
}

export const RegistrationAllowlistModel = getRegistrationAllowlistModel(mongoose.connection);
