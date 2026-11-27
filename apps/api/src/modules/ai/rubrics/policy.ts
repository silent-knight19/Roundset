import { createHash } from 'node:crypto';
import { SanitizedAiError } from '../contracts.js';
import {
  FollowUpProposalV1,
  PlanProposalV1,
  QuestionProposalV1,
} from '../schemas/proposals.js';

export interface AssessmentPolicyFixture {
  readonly policyVersion: string;
  readonly approvedRoles: ReadonlySet<string>;
  readonly approvedTracks: ReadonlySet<string>;
  readonly approvedTopics: ReadonlySet<string>;
  readonly approvedCompetencies: ReadonlySet<string>;
  readonly approvedCriteria: ReadonlySet<string>;
  readonly approvedConcepts: ReadonlySet<string>;
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
};

export interface ServerEntitlementConstraints {
  maxDurationMinutes: number;
  allowedModes: ReadonlySet<'TEXT' | 'VOICE'>;
  allowedQuestionTypes: ReadonlySet<'CONCEPTUAL' | 'SYSTEM_DESIGN' | 'BEHAVIORAL'>;
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
    if (!policy.approvedCompetencies.has(slot.competency)) {
      throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Unapproved plan slot competency');
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
 * Validates QuestionProposal.v1 against rubric total (exactly 10),
 * approved competency/criterion/concept families, and duplicate fingerprints.
 */
export function validateQuestionProposalPolicy(
  proposal: QuestionProposalV1,
  policy: AssessmentPolicyFixture = SYNTHETIC_ASSESSMENT_POLICY_V1,
  priorFingerprints: ReadonlySet<string> = new Set(),
): { proposal: QuestionProposalV1; fingerprint: string } {
  if (!policy.approvedTopics.has(proposal.topic)) {
    throw new SanitizedAiError('AI_SCHEMA_INVALID', 'Unapproved question topic');
  }

  for (const concept of proposal.expectedConcepts) {
    if (!policy.approvedConcepts.has(concept)) {
      throw new SanitizedAiError('AI_SCHEMA_INVALID', 'Unapproved expected concept');
    }
  }

  let totalPoints = 0;
  for (const item of proposal.scoringRubric) {
    if (!policy.approvedCriteria.has(item.criterion)) {
      throw new SanitizedAiError('AI_SCHEMA_INVALID', 'Unapproved rubric criterion family');
    }
    totalPoints += item.maxPoints;
  }

  if (totalPoints !== 10) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      'Question scoringRubric maxPoints must sum to exactly 10',
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

export interface ParentQuestionContext {
  questionId: string;
  topic: string;
  allowedCompetencyTags: ReadonlySet<string>;
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
): FollowUpProposalV1 {
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
  return proposal;
}
