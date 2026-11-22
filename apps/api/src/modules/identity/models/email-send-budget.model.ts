import mongoose, { Schema, HydratedDocument, Model, Connection } from 'mongoose';

export interface IEmailSendBudget {
  dateKey: string;
  generalUsed: number;
  recoveryUsed: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export type EmailSendBudgetDocument = HydratedDocument<IEmailSendBudget>;

export const EmailSendBudgetSchema = new Schema<IEmailSendBudget>(
  {
    dateKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    generalUsed: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    recoveryUsed: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  {
    collection: 'emailSendBudget',
    timestamps: true,
    strict: 'throw',
  }
);

// Critical index defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({dateKey: 1})
EmailSendBudgetSchema.index({ dateKey: 1 }, { unique: true });

export function getEmailSendBudgetModel(
  conn: Connection = mongoose.connection
): Model<IEmailSendBudget> {
  return (
    (conn.models.EmailSendBudget as Model<IEmailSendBudget>) ||
    conn.model<IEmailSendBudget>('EmailSendBudget', EmailSendBudgetSchema)
  );
}

export const EmailSendBudgetModel = getEmailSendBudgetModel(mongoose.connection);
