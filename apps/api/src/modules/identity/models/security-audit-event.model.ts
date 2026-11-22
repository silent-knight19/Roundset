import mongoose, { Schema, HydratedDocument, Model, Connection, Query } from 'mongoose';

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
        validator: function (val: unknown) {
          const self = this as unknown as Partial<ISecurityAuditEvent>;
          if (self.eventType === 'CONSENT_ACCEPTED') {
            if (typeof val !== 'object' || val === null || Array.isArray(val)) {
              return false;
            }
            const meta = val as Record<string, unknown>;
            if (typeof meta.userId !== 'string' || meta.userId.trim().length === 0) {
              return false;
            }
            if (typeof meta.policyId !== 'string' || meta.policyId.trim().length === 0) {
              return false;
            }
            if (typeof meta.consentVersion !== 'string' || meta.consentVersion.trim().length === 0) {
              return false;
            }
            if (meta.consentAt instanceof Date) {
              if (isNaN(meta.consentAt.getTime())) {
                return false;
              }
            } else if (typeof meta.consentAt === 'string') {
              if (meta.consentAt.trim().length === 0 || isNaN(Date.parse(meta.consentAt))) {
                return false;
              }
            } else {
              return false;
            }
          }
          return true;
        },
        message:
          'userId (non-empty string), policyId (non-empty string), consentVersion (non-empty string), and consentAt (valid timestamp) are required in metadata for CONSENT_ACCEPTED audit events',
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

// Block query-based update and replacement paths unconditionally
SecurityAuditEventSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  function () {
    throw new Error('Security audit events are immutable and cannot be updated or replaced');
  }
);

// Block document-level deletion unless retentionPurge is explicitly authorized
SecurityAuditEventSchema.pre(
  'deleteOne',
  { document: true, query: false },
  function (this: SecurityAuditEventDocument, opts?: Record<string, unknown>) {
    if (!opts?.retentionPurge) {
      throw new Error(
        'Security audit events cannot be deleted except via explicit authorized retentionPurge'
      );
    }
  }
);

// Block query-based deletion unless retentionPurge is explicitly authorized
SecurityAuditEventSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  { document: false, query: true },
  function (this: Query<unknown, SecurityAuditEventDocument>) {
    const options = this.getOptions();
    if (!options?.retentionPurge) {
      throw new Error(
        'Security audit events cannot be deleted except via explicit authorized retentionPurge'
      );
    }
  }
);

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
