import mongoose, { Schema, HydratedDocument, Model, Connection, Types } from 'mongoose';

export interface IReauthTicket {
  ticketDigest: string;
  userId: Types.ObjectId;
  sessionId: string;
  action:
    | 'CHANGE_PASSWORD'
    | 'LINK_GOOGLE'
    | 'LINK_PASSWORD'
    | 'UNLINK_IDENTITY'
    | 'REVOKE_OTHER_SESSION'
    | 'DELETE_ACCOUNT';
  target?: string | null;
  methodUsed: 'PASSWORD' | 'FIREBASE_GOOGLE';
  sessionEpochAtIssue: number;
  identityVersionAtIssue: number;
  expiresAt: Date;
  consumedAt?: Date;
}

export type ReauthTicketDocument = HydratedDocument<IReauthTicket>;

export const ReauthTicketSchema = new Schema<IReauthTicket>(
  {
    ticketDigest: {
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
    sessionId: {
      type: String,
      required: true,
      trim: true,
    },
    action: {
      type: String,
      required: true,
      enum: [
        'CHANGE_PASSWORD',
        'LINK_GOOGLE',
        'LINK_PASSWORD',
        'UNLINK_IDENTITY',
        'REVOKE_OTHER_SESSION',
        'DELETE_ACCOUNT',
      ],
    },
    target: {
      type: String,
      default: null,
      trim: true,
    },
    methodUsed: {
      type: String,
      required: true,
      enum: ['PASSWORD', 'FIREBASE_GOOGLE'],
    },
    sessionEpochAtIssue: {
      type: Number,
      required: true,
      min: 1,
    },
    identityVersionAtIssue: {
      type: Number,
      required: true,
      min: 1,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    consumedAt: {
      type: Date,
    },
  },
  {
    collection: 'reauthTickets',
    timestamps: false,
    strict: 'throw',
  }
);

// Critical indexes defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({ticketDigest: 1})
// index({userId: 1, sessionId: 1, action: 1})
// TTL({expiresAt: 1}, expireAfterSeconds: 0)
ReauthTicketSchema.index({ ticketDigest: 1 }, { unique: true });
ReauthTicketSchema.index({ userId: 1, sessionId: 1, action: 1 });
ReauthTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export function getReauthTicketModel(conn: Connection = mongoose.connection): Model<IReauthTicket> {
  return (
    (conn.models.ReauthTicket as Model<IReauthTicket>) ||
    conn.model<IReauthTicket>('ReauthTicket', ReauthTicketSchema)
  );
}

export const ReauthTicketModel = getReauthTicketModel(mongoose.connection);
