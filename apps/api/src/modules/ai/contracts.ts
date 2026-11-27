/**
 * Internal typed contracts for the Phase 4 AI Gateway (P4-AI-01a).
 * These are internal server-only shapes, NOT public/client DTOs.
 */

export type Purpose =
  | 'START_BUNDLE'
  | 'PLAN'
  | 'QUESTION'
  | 'FOLLOW_UP'
  | 'CONTEXT_SUMMARY';

/** Reserved for Phase 7; not callable as a Phase 4 feature. */
export type ReservedPurpose = 'EVALUATION' | 'REPORT';

export type ProviderId = 'GROQ' | 'CLOUDFLARE' | 'MOCK';

export type DataClass = 'SYNTHETIC' | 'USER_TRANSCRIPT' | 'USER_DOCUMENT';

export type SourceKind =
  | 'TRUSTED_TEMPLATE'
  | 'SYNTHETIC_FIXTURE'
  | 'CANDIDATE_RESPONSE'
  | 'CANDIDATE_CONFIGURATION'
  | 'CANDIDATE_DOCUMENT'
  | 'DERIVED_SUMMARY';

export type SourceScope =
  | {
      type: 'SERVER_TEMPLATE';
      templateId: string;
      templateVersion: string;
    }
  | {
      type: 'SYNTHETIC_FIXTURE';
      fixtureId: string;
      fixtureVersion: string;
    }
  | {
      type: 'USER_INTERVIEW';
      userId: string;
      interviewId: string;
      recordId: string;
      recordVersion: string;
    };

export interface SourceDescriptor {
  ref: string;
  kind: SourceKind;
  inheritedClasses: ReadonlyArray<DataClass>;
  ancestorRefs: ReadonlyArray<string>;
  scope: SourceScope;
}

export interface MessagePart {
  text: string;
  sourceRef: string;
}

export interface GenerationMessage {
  role: 'system' | 'user' | 'assistant';
  parts: ReadonlyArray<MessagePart>;
}

export interface GenerationIntent {
  operationId: string;
  generationEpoch: number;
  attemptId: string;
  attemptNo: number;
  interviewId: string;
  purpose: Purpose;
  outputSchemaVersion: string;
  promptVersion: string;
  dataClasses: ReadonlyArray<DataClass>;
  sourceManifest: ReadonlyArray<SourceDescriptor>;
  messages: ReadonlyArray<GenerationMessage>;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  absoluteDeadlineAt: string;
  reasoningProfile: 'NO_REASONING' | 'LOW';
}

export interface NormalizedGenerationUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimated: boolean;
}

export interface NormalizedGenerationResult<T> {
  value: T;
  provider: ProviderId;
  modelId: string;
  attemptId: string;
  finishReason: string;
  latencyMs: number;
  usage: NormalizedGenerationUsage;
  providerRequestId?: string;
}

export type SanitizedAiErrorCode =
  | 'AI_RATE_LIMITED'
  | 'AI_CAPACITY_UNAVAILABLE'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_ABORTED'
  | 'AI_SCHEMA_INVALID'
  | 'AI_OUTPUT_TRUNCATED'
  | 'AI_PRIVACY_INELIGIBLE'
  | 'AI_CONFIGURATION_INVALID'
  | 'AI_OUTPUT_UNSAFE';

/**
 * Sanitized gateway error. Never carries raw prompts, refs, transcripts,
 * unsalted hashes, SDK causes, or private rubric text.
 */
export class SanitizedAiError extends Error {
  public readonly code: SanitizedAiErrorCode;
  public readonly retryable: boolean;

  constructor(code: SanitizedAiErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'SanitizedAiError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type CutoffMode = 'PRE_START' | 'POST_START';

export interface PreStartDeadlineInput {
  readyExpiresAt: Date | string | number;
  reservationExpiresAt: Date | string | number;
  controllerLeaseUntil: Date | string | number;
  requestDeadline: Date | string | number;
}

export interface PostStartDeadlineInput {
  controllerLeaseUntil: Date | string | number;
  effectiveDeadlineAt: Date | string | number;
  requestDeadline: Date | string | number;
  hardExpiryAt?: Date | string | number;
  policyCutoffAt?: Date | string | number;
}

export interface DeadlineComputationResult {
  cutoffAtMs: number;
  remainingMs: number;
}

export const PHASE4_ALLOWED_PURPOSES: ReadonlySet<string> = new Set<Purpose>([
  'START_BUNDLE',
  'PLAN',
  'QUESTION',
  'FOLLOW_UP',
  'CONTEXT_SUMMARY',
]);

export const PHASE4_DATA_CLASSES: ReadonlySet<string> = new Set<DataClass>([
  'SYNTHETIC',
  'USER_TRANSCRIPT',
  'USER_DOCUMENT',
]);
