import {
  CutoffMode,
  DataClass,
  GenerationIntent,
  NormalizedGenerationResult,
  PHASE4_ALLOWED_PURPOSES,
  PostStartDeadlineInput,
  PreStartDeadlineInput,
  ProviderId,
  SanitizedAiError,
  SanitizedAiErrorCode,
} from './contracts.js';
import {
  computeEffectiveProviderTimeoutMs,
  computePostStartCutoff,
  computePreStartCutoff,
} from './deadlines.js';
import {
  AuthoritativeSourceResolver,
  ProviderEligibilityPolicy,
  resolveAndAuthorizeSourceManifest,
} from './provenance.js';

export type MockOutcomeMode =
  | 'SUCCESS'
  | Extract<
      SanitizedAiErrorCode,
      | 'AI_SCHEMA_INVALID'
      | 'AI_OUTPUT_TRUNCATED'
      | 'AI_TIMEOUT'
      | 'AI_PRIVACY_INELIGIBLE'
      | 'AI_CONFIGURATION_INVALID'
      | 'AI_PROVIDER_UNAVAILABLE'
      | 'AI_RATE_LIMITED'
      | 'AI_CAPACITY_UNAVAILABLE'
      | 'AI_ABORTED'
      | 'AI_OUTPUT_UNSAFE'
    >;

export interface OfflinePermitReceipt {
  permitId: string;
  canonicalDataClasses: ReadonlyArray<DataClass>;
  requestIdentity: string;
}

export interface OfflineGatewayRequest {
  authenticatedUserId: string;
  intent: GenerationIntent;
  provider: ProviderId;
  cutoffMode: CutoffMode;
  deadlineInput: PreStartDeadlineInput | PostStartDeadlineInput;
  nowMs: number;
  safetyMarginMs?: number;
  minViableCallMs?: number;
  providerTimeoutMs?: number;
  isFallbackOrRepair?: boolean;
  permitReceipt?: OfflinePermitReceipt;
  mockOutcome?: MockOutcomeMode;
}

function assertValidGenerationIntent(intent: GenerationIntent): void {
  if (!intent || typeof intent !== 'object') {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'GenerationIntent must be an object');
  }
  if (!PHASE4_ALLOWED_PURPOSES.has(intent.purpose)) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Purpose is not permitted in Phase 4',
    );
  }
  if (!intent.operationId || !intent.attemptId || !intent.interviewId) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'GenerationIntent is missing required identifiers',
    );
  }
  if (!Array.isArray(intent.messages) || intent.messages.length === 0) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'GenerationIntent must contain at least one message',
    );
  }
  if (!Array.isArray(intent.sourceManifest)) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'GenerationIntent must contain sourceManifest',
    );
  }
  if (!Number.isFinite(intent.maxOutputTokens) || intent.maxOutputTokens <= 0) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'maxOutputTokens must be a positive finite number',
    );
  }
}

/**
 * Deterministic, strictly offline AI gateway for P4-AI-01a.
 * Performs zero HTTP calls, zero DB writes, and zero real provider access.
 */
export function executeOfflineGeneration(
  request: OfflineGatewayRequest,
  deps: {
    resolver: AuthoritativeSourceResolver;
    eligibilityPolicy: ProviderEligibilityPolicy;
  },
): NormalizedGenerationResult<Record<string, unknown>> {
  assertValidGenerationIntent(request.intent);

  const provenance = resolveAndAuthorizeSourceManifest(
    {
      authenticatedUserId: request.authenticatedUserId,
      interviewId: request.intent.interviewId,
      messages: request.intent.messages,
      descriptors: request.intent.sourceManifest,
      declaredDataClasses: request.intent.dataClasses,
    },
    deps.resolver,
  );

  if (request.permitReceipt) {
    const receiptClasses = [...request.permitReceipt.canonicalDataClasses].join(',');
    const actualClasses = [...provenance.canonicalDataClasses].join(',');
    if (
      receiptClasses !== actualClasses ||
      request.permitReceipt.requestIdentity !== provenance.requestIdentity
    ) {
      throw new SanitizedAiError(
        'AI_PRIVACY_INELIGIBLE',
        'Stale or mismatched admission permit for canonical data classes',
      );
    }
  }

  const eligible = deps.eligibilityPolicy.isEligible({
    provider: request.provider,
    purpose: request.intent.purpose,
    dataClasses: provenance.canonicalDataClasses,
    isFallbackOrRepair: Boolean(request.isFallbackOrRepair),
  });

  if (!eligible) {
    throw new SanitizedAiError(
      'AI_PRIVACY_INELIGIBLE',
      'Provider is not eligible for the derived data classes',
    );
  }

  const safetyMarginMs = request.safetyMarginMs ?? 0;
  const minViableCallMs = request.minViableCallMs ?? 1;
  const deadlineResult =
    request.cutoffMode === 'PRE_START'
      ? computePreStartCutoff(
          request.deadlineInput as PreStartDeadlineInput,
          request.nowMs,
          safetyMarginMs,
          minViableCallMs,
        )
      : computePostStartCutoff(
          request.deadlineInput as PostStartDeadlineInput,
          request.nowMs,
          safetyMarginMs,
          minViableCallMs,
        );

  computeEffectiveProviderTimeoutMs(
    request.providerTimeoutMs ?? 10_000,
    deadlineResult.remainingMs,
  );

  const outcome = request.mockOutcome ?? 'SUCCESS';
  if (outcome !== 'SUCCESS') {
    const retryable =
      outcome === 'AI_TIMEOUT' ||
      outcome === 'AI_RATE_LIMITED' ||
      outcome === 'AI_PROVIDER_UNAVAILABLE' ||
      outcome === 'AI_CAPACITY_UNAVAILABLE';
    throw new SanitizedAiError(outcome, `Offline mock outcome: ${outcome}`, retryable);
  }

  return {
    value: {
      purpose: request.intent.purpose,
      syntheticProposal: `mock-${request.intent.purpose.toLowerCase()}-v1`,
      schemaVersion: request.intent.outputSchemaVersion,
    },
    provider: request.provider,
    modelId: 'mock-offline-model',
    attemptId: request.intent.attemptId,
    finishReason: 'stop',
    latencyMs: 12,
    usage: {
      promptTokens: request.intent.estimatedInputTokens,
      completionTokens: 24,
      totalTokens: request.intent.estimatedInputTokens + 24,
      estimated: true,
    },
    providerRequestId: `mock-req-${request.intent.attemptId}`,
  };
}
