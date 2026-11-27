import {
  DataClass,
  GenerationMessage,
  ProviderId,
  SanitizedAiError,
  SourceDescriptor,
} from '../contracts.js';
import {
  AuthoritativeSourceResolver,
  resolveAndAuthorizeSourceManifest,
  ResolvedManifestResult,
} from '../provenance.js';

export type AdaptiveDifficultyHint = 'MAINTAIN' | 'STEP_UP' | 'STEP_DOWN';

export interface RubricAuthoringPromptInput {
  authenticatedUserId: string;
  interviewId: string;
  operationId: string;
  generationEpoch: number;
  attemptId: string;
  attemptNo: number;
  provider: ProviderId;
  purpose: 'PLAN' | 'START_BUNDLE' | 'QUESTION';
  promptVersion: string;
  outputSchemaVersion: string;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  reasoningProfile: 'NO_REASONING' | 'LOW';
  absoluteDeadlineAt: string;
  /** Server-approved template descriptor & message part. */
  templateDescriptor: SourceDescriptor;
  templateText: string;
  /** Optional normalized candidate configuration (retains USER_TRANSCRIPT class). */
  candidateConfigDescriptor?: SourceDescriptor;
  candidateConfigText?: string;
  /** Server-approved structured metadata only. */
  usedSlotIds: ReadonlyArray<string>;
  usedTopicIds: ReadonlyArray<string>;
  usedCompetencyIds: ReadonlyArray<string>;
  difficultyHint: AdaptiveDifficultyHint;
}

/**
 * Builds an isolated rubric-authoring prompt for PLAN, START_BUNDLE, or QUESTION.
 * Never accepts raw candidate answers, ContextSummary, resume/JD/README excerpts,
 * or prior generated question strings. Validates provenance via P4-AI-01a resolver.
 */
export function buildRubricAuthoringPrompt(
  input: RubricAuthoringPromptInput,
  resolver: AuthoritativeSourceResolver,
): ResolvedManifestResult {
  const descriptors: SourceDescriptor[] = [input.templateDescriptor];
  const parts: Array<{ text: string; sourceRef: string }> = [
    { text: input.templateText, sourceRef: input.templateDescriptor.ref },
  ];
  const declaredClasses: DataClass[] = [...input.templateDescriptor.inheritedClasses];

  if (input.candidateConfigDescriptor && input.candidateConfigText !== undefined) {
    if (input.candidateConfigDescriptor.kind !== 'CANDIDATE_CONFIGURATION') {
      throw new SanitizedAiError(
        'AI_PRIVACY_INELIGIBLE',
        'Rubric-authoring prompt only accepts CANDIDATE_CONFIGURATION for candidate input',
      );
    }
    descriptors.push(input.candidateConfigDescriptor);
    parts.push({
      text: input.candidateConfigText,
      sourceRef: input.candidateConfigDescriptor.ref,
    });
    for (const cls of input.candidateConfigDescriptor.inheritedClasses) {
      if (!declaredClasses.includes(cls)) {
        declaredClasses.push(cls);
      }
    }
  }

  const messages: GenerationMessage[] = [
    {
      role: 'system',
      parts,
    },
  ];

  return resolveAndAuthorizeSourceManifest(
    {
      authenticatedUserId: input.authenticatedUserId,
      interviewId: input.interviewId,
      messages,
      descriptors,
      declaredDataClasses: declaredClasses,
      requestBinding: {
        operationId: input.operationId,
        generationEpoch: input.generationEpoch,
        attemptId: input.attemptId,
        attemptNo: input.attemptNo,
        provider: input.provider,
        purpose: input.purpose,
        promptVersion: input.promptVersion,
        outputSchemaVersion: input.outputSchemaVersion,
        maxOutputTokens: input.maxOutputTokens,
        estimatedInputTokens: input.estimatedInputTokens,
        reasoningProfile: input.reasoningProfile,
        absoluteDeadlineAt: input.absoluteDeadlineAt,
      },
    },
    resolver,
  );
}

export interface LowerTrustContextPart {
  descriptor: SourceDescriptor;
  text: string;
}

/**
 * Deterministically trims lower-trust context parts to a character budget
 * without silently discarding required source provenance.
 * Keeps complete parts from most-recent backwards, or fails closed if
 * a required part cannot fit.
 */
export function trimContextPartsDeterministically(
  parts: ReadonlyArray<LowerTrustContextPart>,
  maxTotalChars: number,
): ReadonlyArray<LowerTrustContextPart> {
  if (!Number.isFinite(maxTotalChars) || maxTotalChars <= 0) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Invalid maxTotalChars budget');
  }

  const kept: LowerTrustContextPart[] = [];
  let usedChars = 0;

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (!part) continue;
    if (usedChars + part.text.length <= maxTotalChars) {
      kept.unshift(part);
      usedChars += part.text.length;
    }
  }

  if (parts.length > 0 && kept.length === 0) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Context budget too small to retain any provenance-bound part',
    );
  }

  return kept;
}

export interface LowerTrustPromptInput {
  authenticatedUserId: string;
  interviewId: string;
  operationId: string;
  generationEpoch: number;
  attemptId: string;
  attemptNo: number;
  provider: ProviderId;
  purpose: 'FOLLOW_UP' | 'CONTEXT_SUMMARY';
  promptVersion: string;
  outputSchemaVersion: string;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  reasoningProfile: 'NO_REASONING' | 'LOW';
  absoluteDeadlineAt: string;
  templateDescriptor: SourceDescriptor;
  templateText: string;
  contextParts: ReadonlyArray<LowerTrustContextPart>;
  maxContextChars: number;
}

/**
 * Builds a lower-trust prompt for FOLLOW_UP or CONTEXT_SUMMARY,
 * preserving complete transitive source lineage (including USER_DOCUMENT).
 */
export function buildLowerTrustPrompt(
  input: LowerTrustPromptInput,
  resolver: AuthoritativeSourceResolver,
): ResolvedManifestResult {
  const trimmed = trimContextPartsDeterministically(input.contextParts, input.maxContextChars);

  const descriptors: SourceDescriptor[] = [input.templateDescriptor];
  const userParts: Array<{ text: string; sourceRef: string }> = [];
  const classSet = new Set<DataClass>(input.templateDescriptor.inheritedClasses);

  for (const item of trimmed) {
    descriptors.push(item.descriptor);
    userParts.push({ text: item.text, sourceRef: item.descriptor.ref });
    for (const cls of item.descriptor.inheritedClasses) {
      classSet.add(cls);
    }
  }

  const messages: GenerationMessage[] = [
    {
      role: 'system',
      parts: [{ text: input.templateText, sourceRef: input.templateDescriptor.ref }],
    },
    ...(userParts.length > 0 ? [{ role: 'user' as const, parts: userParts }] : []),
  ];

  return resolveAndAuthorizeSourceManifest(
    {
      authenticatedUserId: input.authenticatedUserId,
      interviewId: input.interviewId,
      messages,
      descriptors,
      declaredDataClasses: Array.from(classSet),
      requestBinding: {
        operationId: input.operationId,
        generationEpoch: input.generationEpoch,
        attemptId: input.attemptId,
        attemptNo: input.attemptNo,
        provider: input.provider,
        purpose: input.purpose,
        promptVersion: input.promptVersion,
        outputSchemaVersion: input.outputSchemaVersion,
        maxOutputTokens: input.maxOutputTokens,
        estimatedInputTokens: input.estimatedInputTokens,
        reasoningProfile: input.reasoningProfile,
        absoluteDeadlineAt: input.absoluteDeadlineAt,
      },
    },
    resolver,
  );
}
