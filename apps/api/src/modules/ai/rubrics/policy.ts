import { createHash } from 'node:crypto';
import { SanitizedAiError } from '../contracts.js';
import {
  ContextSummaryProposalV1,
  FollowUpProposalV1,
  PlanProposalV1,
  QuestionProposalV1,
  StartBundleProposalV1,
} from '../schemas/proposals.js';

export interface AssessmentPolicyFixture {
  readonly policyVersion: string;
  readonly approvedRoles: ReadonlySet<string>;
  readonly approvedTracks: ReadonlySet<string>;
  readonly approvedTopics: ReadonlySet<string>;
  readonly approvedCompetencies: ReadonlySet<string>;
  readonly approvedCriteria: ReadonlySet<string>;
  readonly approvedConcepts: ReadonlySet<string>;
  readonly roleToTracks: Readonly<Record<string, ReadonlySet<string>>>;
  readonly trackToTopics: Readonly<Record<string, ReadonlySet<string>>>;
  readonly topicToCompetencies: Readonly<Record<string, ReadonlySet<string>>>;
  readonly competencyToConcepts: Readonly<Record<string, ReadonlySet<string>>>;
  readonly competencyToCriteria: Readonly<Record<string, ReadonlySet<string>>>;
  readonly competencyRubricTemplates: Readonly<
    Record<string, ReadonlyArray<Readonly<Record<string, number>>>>
  >;
  readonly criterionApprovedDescriptions: Readonly<Record<string, string>>;
  readonly followUpApprovedTexts: Readonly<Record<string, ReadonlySet<string>>>;
}

/**
 * Proposed synthetic assessment-policy fixture for offline P4-AI-03a validation.
 * Production competency catalogs require separate product-owner approval.
 */
export const SYNTHETIC_ASSESSMENT_POLICY_V1: AssessmentPolicyFixture = {
  policyVersion: 'synthetic-policy-v1',
  approvedRoles: new Set(['backend_engineer', 'frontend_engineer', 'fullstack_engineer']),
  approvedTracks: new Set(['node_ts', 'react_ts', 'distributed_systems']),
  approvedTopics: new Set(['api_design', 'concurrency', 'data_modeling', 'caching', 'testing']),
  approvedCompetencies: new Set([
    'system_reliability',
    'api_contracts',
    'async_control',
    'state_management',
  ]),
  approvedCriteria: new Set([
    'correctness',
    'edge_cases',
    'scalability',
    'clarity',
    'tradeoffs',
  ]),
  approvedConcepts: new Set([
    'idempotency',
    'backpressure',
    'rate_limiting',
    'atomicity',
    'consistency',
    'caching_invalidation',
  ]),
  roleToTracks: {
    backend_engineer: new Set(['node_ts', 'distributed_systems']),
    frontend_engineer: new Set(['react_ts']),
    fullstack_engineer: new Set(['node_ts', 'react_ts']),
  },
  trackToTopics: {
    node_ts: new Set(['api_design', 'concurrency', 'caching', 'testing']),
    react_ts: new Set(['state_management', 'testing', 'api_design']),
    distributed_systems: new Set(['concurrency', 'data_modeling', 'caching']),
  },
  topicToCompetencies: {
    api_design: new Set(['api_contracts', 'system_reliability']),
    concurrency: new Set(['async_control', 'system_reliability']),
    data_modeling: new Set(['state_management', 'system_reliability']),
    caching: new Set(['system_reliability', 'state_management']),
    testing: new Set(['api_contracts', 'async_control']),
  },
  competencyToConcepts: {
    api_contracts: new Set(['idempotency', 'rate_limiting', 'atomicity']),
    async_control: new Set(['backpressure', 'atomicity', 'consistency']),
    system_reliability: new Set(['idempotency', 'rate_limiting', 'consistency', 'caching_invalidation']),
    state_management: new Set(['consistency', 'caching_invalidation', 'atomicity']),
  },
  competencyToCriteria: {
    api_contracts: new Set(['correctness', 'edge_cases', 'clarity', 'tradeoffs']),
    async_control: new Set(['correctness', 'edge_cases', 'scalability', 'tradeoffs']),
    system_reliability: new Set(['correctness', 'scalability', 'edge_cases', 'tradeoffs']),
    state_management: new Set(['correctness', 'clarity', 'tradeoffs']),
  },
  competencyRubricTemplates: {
    api_contracts: [
      { correctness: 5, edge_cases: 5 },
      { correctness: 4, edge_cases: 4, clarity: 2 },
    ],
    async_control: [
      { correctness: 5, scalability: 5 },
      { correctness: 4, edge_cases: 3, scalability: 3 },
    ],
    system_reliability: [
      { correctness: 5, scalability: 5 },
      { correctness: 4, edge_cases: 3, tradeoffs: 3 },
    ],
    state_management: [
      { correctness: 5, clarity: 5 },
      { correctness: 4, clarity: 3, tradeoffs: 3 },
    ],
  },
  criterionApprovedDescriptions: {
    correctness: 'Explains idempotency key storage.',
    edge_cases: 'Handles concurrent duplicate deliveries.',
    scalability: 'Evaluates throughput and bounded resource usage.',
    clarity: 'Communicates structure and contracts clearly.',
    tradeoffs: 'Compares alternative designs and failure modes.',
  },
  followUpApprovedTexts: {
    api_contracts: new Set([
      'Could you clarify how you store the idempotency key?',
      'What happens if a client retries with a different payload?',
    ]),
    async_control: new Set([
      'How do you bound queue growth under backpressure?',
    ]),
  },
};

export interface ServerEntitlementConstraints {
  maxDurationMinutes: number;
  allowedModes: ReadonlySet<'TEXT' | 'VOICE'>;
  allowedQuestionTypes: ReadonlySet<'CONCEPTUAL' | 'SYSTEM_DESIGN' | 'BEHAVIORAL'>;
}

export interface PlanSlot {
  slotId: string;
  topic: string;
  competency: string;
  weight: number;
  questionType: 'CONCEPTUAL' | 'SYSTEM_DESIGN' | 'BEHAVIORAL';
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
}

/**
 * Validates a server-authorized interview plan against policy and entitlements.
 * Topic weights must sum to exactly 100 and slot IDs must be unique.
 */
export function validateTrustedPlan(
  plan: PlanProposalV1,
  entitlement: ServerEntitlementConstraints,
  policy: AssessmentPolicyFixture = SYNTHETIC_ASSESSMENT_POLICY_V1,
): PlanProposalV1 {
  if (!policy.approvedRoles.has(plan.role)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Unapproved interview role');
  }
  if (!policy.approvedTracks.has(plan.track)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Unapproved interview track');
  }
  if (!policy.roleToTracks[plan.role]?.has(plan.track)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Track is not approved for role');
  }
  if (!entitlement.allowedModes.has(plan.mode)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Interview mode exceeds entitlement');
  }
  if (plan.durationMinutes > entitlement.maxDurationMinutes) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Interview duration exceeds server-approved entitlement',
    );
  }
  for (const qType of plan.allowedQuestionTypes) {
    if (!entitlement.allowedQuestionTypes.has(qType)) {
      throw new SanitizedAiError(
        'AI_CONFIGURATION_INVALID',
        'Allowed question type exceeds entitlement',
      );
    }
  }

  const seenSlotIds = new Set<string>();
  let totalWeight = 0;

  for (const slot of plan.slots) {
    if (seenSlotIds.has(slot.slotId)) {
      throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Duplicate plan slotId');
    }
    seenSlotIds.add(slot.slotId);

    if (!policy.approvedTopics.has(slot.topic)) {
      throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Unapproved plan slot topic');
    }
    if (!policy.trackToTopics[plan.track]?.has(slot.topic)) {
      throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Topic is not approved for track');
    }
    if (!policy.approvedCompetencies.has(slot.competency)) {
      throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Unapproved plan slot competency');
    }
    if (!policy.topicToCompetencies[slot.topic]?.has(slot.competency)) {
      throw new SanitizedAiError(
        'AI_CONFIGURATION_INVALID',
        'Competency is not approved for topic',
      );
    }
    if (!plan.allowedQuestionTypes.includes(slot.questionType)) {
      throw new SanitizedAiError(
        'AI_CONFIGURATION_INVALID',
        'Plan slot questionType not in allowedQuestionTypes',
      );
    }
    totalWeight += slot.weight;
  }

  if (totalWeight !== 100) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Plan topic weights must sum to exactly 100',
    );
  }

  return plan;
}

/**
 * Deterministic normalized text fingerprint for duplicate-question rejection
 * outside the privileged rubric-authoring prompt.
 */
export function computeNormalizedQuestionFingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Validates QuestionProposal.v1 against the exact assigned PlanSlot,
 * rubric total (exactly 10), server-owned criterion descriptions,
 * approved competency/criterion/concept families, and duplicate fingerprints.
 */
export function validateQuestionProposalPolicy(
  proposal: QuestionProposalV1,
  slot: PlanSlot,
  policy: AssessmentPolicyFixture = SYNTHETIC_ASSESSMENT_POLICY_V1,
  priorFingerprints: ReadonlySet<string> = new Set(),
): { proposal: QuestionProposalV1; fingerprint: string } {
  if (proposal.topic !== slot.topic) {
    throw new SanitizedAiError('AI_SCHEMA_INVALID', 'Question topic does not match assigned slot');
  }
  if (proposal.type !== slot.questionType) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Question type does not match assigned slot',
    );
  }
  if (proposal.difficulty !== slot.difficulty) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Question difficulty does not match assigned slot',
    );
  }

  const allowedConcepts = policy.competencyToConcepts[slot.competency];
  const seenConcepts = new Set<string>();
  for (const concept of proposal.expectedConcepts) {
    if (seenConcepts.has(concept)) {
      throw new SanitizedAiError('AI_SCHEMA_INVALID', 'Duplicate expected concept');
    }
    seenConcepts.add(concept);
    if (!policy.approvedConcepts.has(concept) || !allowedConcepts?.has(concept)) {
      throw new SanitizedAiError(
        'AI_SCHEMA_INVALID',
        'Expected concept is not approved for slot competency',
      );
    }
  }

  const allowedCriteria = policy.competencyToCriteria[slot.competency];
  const seenCriteria = new Set<string>();
  let totalPoints = 0;
  for (const item of proposal.scoringRubric) {
    if (seenCriteria.has(item.criterion)) {
      throw new SanitizedAiError('AI_SCHEMA_INVALID', 'Duplicate rubric criterion');
    }
    seenCriteria.add(item.criterion);

    if (!policy.approvedCriteria.has(item.criterion) || !allowedCriteria?.has(item.criterion)) {
      throw new SanitizedAiError(
        'AI_SCHEMA_INVALID',
        'Rubric criterion is not approved for slot competency',
      );
    }

    const serverDescription = policy.criterionApprovedDescriptions[item.criterion];
    if (!serverDescription || item.description !== serverDescription) {
      throw new SanitizedAiError(
        'AI_SCHEMA_INVALID',
        'Rubric criterion description does not match server-owned grading policy',
      );
    }
    totalPoints += item.maxPoints;
  }

  if (totalPoints !== 10) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Question scoringRubric maxPoints must sum to exactly 10',
    );
  }

  const allowedTemplates = policy.competencyRubricTemplates[slot.competency];
  if (!allowedTemplates || allowedTemplates.length === 0) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'No approved rubric weighting template for slot competency',
    );
  }

  const actualWeights = new Map<string, number>();
  for (const item of proposal.scoringRubric) {
    actualWeights.set(item.criterion, item.maxPoints);
  }

  const matchesTemplate = allowedTemplates.some((tpl) => {
    const entries = Object.entries(tpl);
    if (entries.length !== actualWeights.size) return false;
    return entries.every(([criterion, pts]) => actualWeights.get(criterion) === pts);
  });

  if (!matchesTemplate) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Question scoringRubric weights do not match an approved policy template',
    );
  }

  const fingerprint = computeNormalizedQuestionFingerprint(proposal.text);
  if (priorFingerprints.has(fingerprint)) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Duplicate question proposal rejected by deterministic fingerprint',
    );
  }

  return { proposal, fingerprint };
}

/**
 * Validates StartBundleProposal.v1 (offline fixtures only), ensuring Q1
 * is consistent with the first slot of its validated plan.
 */
export function validateStartBundlePolicy(
  bundle: StartBundleProposalV1,
  entitlement: ServerEntitlementConstraints,
  policy: AssessmentPolicyFixture = SYNTHETIC_ASSESSMENT_POLICY_V1,
  priorFingerprints: ReadonlySet<string> = new Set(),
): { bundle: StartBundleProposalV1; q1Fingerprint: string } {
  validateTrustedPlan(bundle.plan, entitlement, policy);
  const firstSlot = bundle.plan.slots[0];
  if (!firstSlot) {
    throw new SanitizedAiError('AI_SCHEMA_INVALID', 'StartBundle plan must contain at least one slot');
  }
  const { fingerprint } = validateQuestionProposalPolicy(
    bundle.q1,
    firstSlot,
    policy,
    priorFingerprints,
  );
  return { bundle, q1Fingerprint: fingerprint };
}

export interface ParentQuestionContext {
  questionId: string;
  topic: string;
  allowedCompetencyTags: ReadonlySet<string>;
  followUpCount: number;
  maxFollowUps: number;
}

/** Fixed server-owned clarifying fallback when semantic compatibility fails. */
export const SERVER_CLARIFYING_FALLBACK = {
  kind: 'CLARIFY' as const,
  text: 'Could you clarify the key trade-offs and edge cases in your approach?',
};

/** Server-owned unscored transition event (never model-authored). */
export const SERVER_TRANSITION_EVENT = {
  type: 'SERVER_TRANSITION' as const,
  text: 'Moving to the next topic.',
};

export function validateFollowUpProposalPolicy(
  proposal: FollowUpProposalV1,
  parent: ParentQuestionContext,
  policy: AssessmentPolicyFixture = SYNTHETIC_ASSESSMENT_POLICY_V1,
): FollowUpProposalV1 {
  if (parent.followUpCount >= parent.maxFollowUps) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Follow-up turn limit exceeded for parent question',
    );
  }
  if (proposal.parentQuestionId !== parent.questionId) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Follow-up parentQuestionId does not match active parent question',
    );
  }
  if (!parent.allowedCompetencyTags.has(proposal.competencyTag)) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Follow-up competencyTag is outside parent question scope',
    );
  }
  const approvedTexts = policy.followUpApprovedTexts[proposal.competencyTag];
  if (!approvedTexts || !approvedTexts.has(proposal.text)) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Follow-up text failed conservative semantic compatibility check',
    );
  }
  return proposal;
}

export function validateContextSummaryPolicy(
  summary: ContextSummaryProposalV1,
  expectedMaxCoveredTurns: number,
  allowedTopics: ReadonlySet<string>,
): ContextSummaryProposalV1 {
  if (summary.coveredTurns > expectedMaxCoveredTurns) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'ContextSummary coveredTurns exceeds authoritative turn count',
    );
  }
  for (const topic of summary.keyTopics) {
    if (!allowedTopics.has(topic)) {
      throw new SanitizedAiError(
        'AI_SCHEMA_INVALID',
        'ContextSummary keyTopics contains unapproved topic',
      );
    }
  }
  return summary;
}
