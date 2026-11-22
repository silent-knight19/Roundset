import mongoose, { Schema, HydratedDocument, Model, Connection } from 'mongoose';

export interface IConsentAuditMetadata {
  userId: string;
  policyId: string;
  consentVersion: string;
  consentAt: Date | string;
  [key: string]: unknown;
}

export interface ISecurityAuditEvent {
  eventId: string;
  eventType: string;
  actorId?: string;
  targetId?: string;
  requestId: string;
  outcome: 'SUCCESS' | 'FAILURE';
  reasonCode?: string;
  at: Date;
  metadata?: Record<string, unknown>;
}

export type SecurityAuditEventDocument = HydratedDocument<ISecurityAuditEvent>;

export const SecurityAuditEventSchema = new Schema<ISecurityAuditEvent>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
    },
    actorId: {
      type: String,
      trim: true,
    },
    targetId: {
      type: String,
      trim: true,
    },
    requestId: {
      type: String,
      required: true,
      trim: true,
    },
    outcome: {
      type: String,
      required: true,
      enum: ['SUCCESS', 'FAILURE'],
    },
    reasonCode: {
      type: String,
      trim: true,
    },
    at: {
      type: Date,
      required: true,
      default: Date.now,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: () => ({}),
      validate: {
        validator: function (this: ISecurityAuditEvent, val: unknown) {
          if (this.eventType === 'CONSENT_ACCEPTED') {
            const meta = (val || {}) as Record<string, unknown>;
            return Boolean(meta.userId && meta.policyId && meta.consentVersion && meta.consentAt);
          }
          return true;
        },
        message: 'userId, policyId, consentVersion, and consentAt are required in metadata for CONSENT_ACCEPTED audit events',
      },
    },
  },
  {
    collection: 'securityAuditEvents',
    timestamps: false,
    strict: 'throw',
  }
);

// Invariant: Security audit events are append-only and strictly immutable
SecurityAuditEventSchema.pre('save', function () {
  if (!this.isNew) {
    throw new Error('Security audit events are immutable and cannot be updated');
  }
});

SecurityAuditEventSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  throw new Error('Security audit events are immutable and cannot be updated');
});

// Critical indexes defined in P2_AUTH_API_CONTRACTS_v1.md §4:
// unique({eventId: 1})
// index({targetId: 1, at: -1})
// index({at: -1})
SecurityAuditEventSchema.index({ eventId: 1 }, { unique: true });
SecurityAuditEventSchema.index({ targetId: 1, at: -1 });
SecurityAuditEventSchema.index({ at: -1 });

export function getSecurityAuditEventModel(
  conn: Connection = mongoose.connection
): Model<ISecurityAuditEvent> {
  return (
    (conn.models.SecurityAuditEvent as Model<ISecurityAuditEvent>) ||
    conn.model<ISecurityAuditEvent>('SecurityAuditEvent', SecurityAuditEventSchema)
  );
}

export const SecurityAuditEventModel = getSecurityAuditEventModel(mongoose.connection);
