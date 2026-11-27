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
import { SYNTHETIC_ASSESSMENT_POLICY_V1 } from '../rubrics/policy.js';

export type AdaptiveDifficultyHint = 'MAINTAIN' | 'STEP_UP' | 'STEP_DOWN';

const VALID_RUBRIC_PURPOSES: ReadonlySet<string> = new Set(['PLAN', 'START_BUNDLE', 'QUESTION']);
const VALID_LOWER_TRUST_PURPOSES: ReadonlySet<string> = new Set(['FOLLOW_UP', 'CONTEXT_SUMMARY']);
const VALID_DIFFICULTY_HINTS: ReadonlySet<string> = new Set(['MAINTAIN', 'STEP_UP', 'STEP_DOWN']);
const VALID_DIFFICULTIES: ReadonlySet<string> = new Set(['EASY', 'MEDIUM', 'HARD']);

export interface StructuredCandidateConfig {
  role: string;
  track: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  topic: string;
  competency: string;
}

export function serializeCanonicalCandidateConfig(config: StructuredCandidateConfig): string {
  if (!config || typeof config !== 'object') {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Candidate configuration must be an object');
  }
  if (!SYNTHETIC_ASSESSMENT_POLICY_V1.approvedRoles.has(config.role)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Unapproved candidate configuration role');
  }
  if (!SYNTHETIC_ASSESSMENT_POLICY_V1.approvedTracks.has(config.track)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Unapproved candidate configuration track');
  }
  if (!VALID_DIFFICULTIES.has(config.difficulty)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Invalid candidate configuration difficulty');
  }
  if (!SYNTHETIC_ASSESSMENT_POLICY_V1.approvedTopics.has(config.topic)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Unapproved candidate configuration topic');
  }
  if (!SYNTHETIC_ASSESSMENT_POLICY_V1.approvedCompetencies.has(config.competency)) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Unapproved candidate configuration competency',
    );
  }
  return `role=${config.role};track=${config.track};difficulty=${config.difficulty};topic=${config.topic};competency=${config.competency}`;
}

function assertTrustedTemplateDescriptor(descriptor: SourceDescriptor): void {
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    descriptor.kind !== 'TRUSTED_TEMPLATE' ||
    descriptor.scope?.type !== 'SERVER_TEMPLATE'
  ) {
    throw new SanitizedAiError(
      'AI_PRIVACY_INELIGIBLE',
      'Privileged template must be a TRUSTED_TEMPLATE with SERVER_TEMPLATE scope',
    );
  }
}

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
  /** Must be a registered immutable TRUSTED_TEMPLATE with SERVER_TEMPLATE scope. */
  templateDescriptor: SourceDescriptor;
  templateText: string;
  /** Optional structured candidate configuration (retains USER_TRANSCRIPT class). */
  candidateConfigDescriptor?: SourceDescriptor;
  candidateConfig?: StructuredCandidateConfig;
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
  if (!VALID_RUBRIC_PURPOSES.has(input.purpose)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Invalid rubric-authoring purpose');
  }
  if (!VALID_DIFFICULTY_HINTS.has(input.difficultyHint)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Invalid adaptive difficulty hint');
  }
  if (
    !Array.isArray(input.usedSlotIds) ||
    !Array.isArray(input.usedTopicIds) ||
    !Array.isArray(input.usedCompetencyIds)
  ) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Invalid used-slot/topic/competency IDs');
  }

  assertTrustedTemplateDescriptor(input.templateDescriptor);

  const descriptors: SourceDescriptor[] = [input.templateDescriptor];
  const parts: Array<{ text: string; sourceRef: string }> = [
    { text: input.templateText, sourceRef: input.templateDescriptor.ref },
  ];
  const declaredClasses: DataClass[] = [...input.templateDescriptor.inheritedClasses];

  if (input.candidateConfigDescriptor && input.candidateConfig !== undefined) {
    if (input.candidateConfigDescriptor.kind !== 'CANDIDATE_CONFIGURATION') {
      throw new SanitizedAiError(
        'AI_PRIVACY_INELIGIBLE',
        'Rubric-authoring prompt only accepts CANDIDATE_CONFIGURATION for candidate input',
      );
    }
    const canonicalConfigText = serializeCanonicalCandidateConfig(input.candidateConfig);
    descriptors.push(input.candidateConfigDescriptor);
    parts.push({
      text: canonicalConfigText,
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
 * accounting for newline separators and prompt overhead.
 */
export function trimContextPartsDeterministically(
  parts: ReadonlyArray<LowerTrustContextPart>,
  maxTotalChars: number,
  overheadChars = 0,
): ReadonlyArray<LowerTrustContextPart> {
  if (!Number.isFinite(maxTotalChars) || maxTotalChars <= 0) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Invalid maxTotalChars budget');
  }
  if (!Number.isFinite(overheadChars) || overheadChars < 0) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Invalid overheadChars');
  }

  const available = maxTotalChars - overheadChars;
  if (parts.length > 0 && available <= 0) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Context budget exhausted by prompt overhead',
    );
  }

  const kept: LowerTrustContextPart[] = [];
  let usedChars = 0;

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (!part) continue;
    const separatorCost = kept.length > 0 ? 1 : 0;
    if (usedChars + separatorCost + part.text.length <= available) {
      kept.unshift(part);
      usedChars += separatorCost + part.text.length;
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
  /** Ancestor descriptors required for complete lineage closure even if their text is trimmed. */
  ancestorDescriptors?: ReadonlyArray<SourceDescriptor>;
  maxContextChars: number;
}

/**
 * Builds a lower-trust prompt for FOLLOW_UP or CONTEXT_SUMMARY,
 * preserving complete transitive source lineage (including USER_DOCUMENT)
 * even when ancestor text is trimmed for budget reasons.
 */
export function buildLowerTrustPrompt(
  input: LowerTrustPromptInput,
  resolver: AuthoritativeSourceResolver,
): ResolvedManifestResult {
  if (!VALID_LOWER_TRUST_PURPOSES.has(input.purpose)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Invalid lower-trust prompt purpose');
  }
  assertTrustedTemplateDescriptor(input.templateDescriptor);

  const trimmed = trimContextPartsDeterministically(
    input.contextParts,
    input.maxContextChars,
    input.templateText.length,
  );

  const descriptorByRef = new Map<string, SourceDescriptor>();
  descriptorByRef.set(input.templateDescriptor.ref, input.templateDescriptor);

  const userParts: Array<{ text: string; sourceRef: string }> = [];
  const classSet = new Set<DataClass>(input.templateDescriptor.inheritedClasses);

  for (const item of trimmed) {
    descriptorByRef.set(item.descriptor.ref, item.descriptor);
    userParts.push({ text: item.text, sourceRef: item.descriptor.ref });
    for (const cls of item.descriptor.inheritedClasses) {
      classSet.add(cls);
    }
  }

  if (input.ancestorDescriptors) {
    for (const anc of input.ancestorDescriptors) {
      if (!descriptorByRef.has(anc.ref)) {
        descriptorByRef.set(anc.ref, anc);
      }
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
      descriptors: Array.from(descriptorByRef.values()),
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
