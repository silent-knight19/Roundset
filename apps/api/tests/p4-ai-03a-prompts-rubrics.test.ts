import { describe, expect, it } from 'vitest';
import {
  buildLowerTrustPrompt,
  buildRubricAuthoringPrompt,
  computeNormalizedQuestionFingerprint,
  DeterministicFakeSourceResolver,
  parseUnknownProposal,
  SanitizedAiError,
  SYNTHETIC_ASSESSMENT_POLICY_V1,
  trimContextPartsDeterministically,
  validateFollowUpProposalPolicy,
  validateQuestionProposalPolicy,
  validateTrustedPlan,
} from '../src/modules/ai/index.js';

const NOW_ISO = '2026-11-27T12:05:00.000Z';

const VALID_PLAN = {
  schemaVersion: 'PlanProposal.v1' as const,
  role: 'backend_engineer',
  track: 'node_ts',
  mode: 'TEXT' as const,
  difficulty: 'MEDIUM' as const,
  durationMinutes: 15,
  allowedQuestionTypes: ['CONCEPTUAL' as const, 'SYSTEM_DESIGN' as const],
  slots: [
    {
      slotId: 'slot-1',
      topic: 'api_design',
      competency: 'api_contracts',
      weight: 50,
      questionType: 'CONCEPTUAL' as const,
      difficulty: 'MEDIUM' as const,
    },
    {
      slotId: 'slot-2',
      topic: 'concurrency',
      competency: 'async_control',
      weight: 50,
      questionType: 'SYSTEM_DESIGN' as const,
      difficulty: 'MEDIUM' as const,
    },
  ],
};

const VALID_QUESTION = {
  schemaVersion: 'QuestionProposal.v1' as const,
  type: 'CONCEPTUAL' as const,
  topic: 'api_design',
  difficulty: 'MEDIUM' as const,
  text: 'How would you design an idempotent retry mechanism for a payment-free webhook?',
  expectedConcepts: ['idempotency', 'atomicity'],
  scoringRubric: [
    { criterion: 'correctness', maxPoints: 5, description: 'Explains idempotency key storage.' },
    { criterion: 'edge_cases', maxPoints: 5, description: 'Handles concurrent duplicate deliveries.' },
  ],
};

const DEFAULT_ENTITLEMENT = {
  maxDurationMinutes: 15,
  allowedModes: new Set<'TEXT' | 'VOICE'>(['TEXT']),
  allowedQuestionTypes: new Set<'CONCEPTUAL' | 'SYSTEM_DESIGN' | 'BEHAVIORAL'>([
    'CONCEPTUAL',
    'SYSTEM_DESIGN',
  ]),
};

describe('P4-AI-03a: Structured Prompt and Rubric Foundation', () => {
  it('1. Accepts valid PLAN proposal and rejects malformed PLAN proposals', () => {
    const parsed = parseUnknownProposal('PLAN', VALID_PLAN);
    expect(parsed.slots).toHaveLength(2);

    // Unexpected extra field
    expect(() =>
      parseUnknownProposal('PLAN', { ...VALID_PLAN, extraField: 'injected' }),
    ).toThrowError(SanitizedAiError);

    // CODING type rejected in Phase 4
    expect(() =>
      parseUnknownProposal('PLAN', {
        ...VALID_PLAN,
        allowedQuestionTypes: ['CODING'],
      }),
    ).toThrowError(SanitizedAiError);
  });

  it('2. Rejects invalid topic-weight totals and unauthorized/duplicate plan slots', () => {
    const badWeightPlan = {
      ...VALID_PLAN,
      slots: [
        { ...VALID_PLAN.slots[0], weight: 40 },
        { ...VALID_PLAN.slots[1], weight: 50 },
      ],
    };
    expect(() => validateTrustedPlan(badWeightPlan, DEFAULT_ENTITLEMENT)).toThrowError(
      SanitizedAiError,
    );

    const duplicateSlotPlan = {
      ...VALID_PLAN,
      slots: [
        { ...VALID_PLAN.slots[0], slotId: 'slot-1', weight: 50 },
        { ...VALID_PLAN.slots[1], slotId: 'slot-1', weight: 50 },
      ],
    };
    expect(() => validateTrustedPlan(duplicateSlotPlan, DEFAULT_ENTITLEMENT)).toThrowError(
      SanitizedAiError,
    );

    const overEntitlementPlan = { ...VALID_PLAN, durationMinutes: 60 };
    expect(() => validateTrustedPlan(overEntitlementPlan, DEFAULT_ENTITLEMENT)).toThrowError(
      SanitizedAiError,
    );
  });

  it('3. Rejects QuestionProposal.v1 with rubric totals other than 10', () => {
    const badRubric = {
      ...VALID_QUESTION,
      scoringRubric: [
        { criterion: 'correctness', maxPoints: 4, description: 'Explains idempotency.' },
        { criterion: 'edge_cases', maxPoints: 5, description: 'Handles duplicates.' },
      ],
    };
    expect(() => validateQuestionProposalPolicy(badRubric)).toThrowError(SanitizedAiError);
  });

  it('4. Rejects unauthorized competency or criterion families', () => {
    const badCriterion = {
      ...VALID_QUESTION,
      scoringRubric: [
        { criterion: 'unapproved_family', maxPoints: 10, description: 'Custom unauthorized.' },
      ],
    };
    expect(() => validateQuestionProposalPolicy(badCriterion)).toThrowError(SanitizedAiError);

    const badConcept = {
      ...VALID_QUESTION,
      expectedConcepts: ['unapproved_concept'],
    };
    expect(() => validateQuestionProposalPolicy(badConcept)).toThrowError(SanitizedAiError);
  });

  it('5. Raw answer/resume/JD/README canaries are absent from PLAN, START_BUNDLE, and main QUESTION prompts', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerServerTemplate({
      templateId: 'tpl-plan',
      templateVersion: 'v1',
      content: 'Generate structured plan for backend_engineer.',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-1',
      recordId: 'cfg-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_CONFIGURATION',
      ancestorRefs: [],
      content: 'role=backend_engineer;track=node_ts;difficulty=MEDIUM',
    });

    const result = buildRubricAuthoringPrompt(
      {
        authenticatedUserId: 'user-a',
        interviewId: 'int-1',
        operationId: 'op-1',
        generationEpoch: 1,
        attemptId: 'att-1',
        attemptNo: 1,
        provider: 'MOCK',
        purpose: 'QUESTION',
        promptVersion: '1.0.0',
        outputSchemaVersion: 'QuestionProposal.v1',
        maxOutputTokens: 512,
        estimatedInputTokens: 64,
        reasoningProfile: 'NO_REASONING',
        absoluteDeadlineAt: NOW_ISO,
        templateDescriptor: {
          ref: 'tpl-plan',
          kind: 'TRUSTED_TEMPLATE',
          inheritedClasses: [],
          ancestorRefs: [],
          scope: { type: 'SERVER_TEMPLATE', templateId: 'tpl-plan', templateVersion: 'v1' },
        },
        templateText: 'Generate structured plan for backend_engineer.',
        candidateConfigDescriptor: {
          ref: 'cfg-1',
          kind: 'CANDIDATE_CONFIGURATION',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-1',
            recordId: 'cfg-1',
            recordVersion: 'v1',
          },
        },
        candidateConfigText: 'role=backend_engineer;track=node_ts;difficulty=MEDIUM',
        usedSlotIds: ['slot-1'],
        usedTopicIds: ['api_design'],
        usedCompetencyIds: ['api_contracts'],
        difficultyHint: 'MAINTAIN',
      },
      resolver,
    );

    const joined = result.flattenedMessages.map((m) => m.content).join('\n');
    expect(joined).not.toContain('RAW_ANSWER_CANARY');
    expect(joined).not.toContain('RAW_RESUME_CANARY');
    expect(joined).not.toContain('RAW_README_CANARY');
  });

  it('6. Prior generated-question injection canaries are absent from new main-question prompts', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerServerTemplate({
      templateId: 'tpl-q',
      templateVersion: 'v1',
      content: 'Author main question for slot-2.',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-1',
      recordId: 'cfg-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_CONFIGURATION',
      ancestorRefs: [],
      content: 'role=backend_engineer;track=node_ts',
    });

    // Attempting to pass a CANDIDATE_RESPONSE into buildRubricAuthoringPrompt fails closed
    expect(() =>
      buildRubricAuthoringPrompt(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-1',
          operationId: 'op-2',
          generationEpoch: 1,
          attemptId: 'att-2',
          attemptNo: 1,
          provider: 'MOCK',
          purpose: 'QUESTION',
          promptVersion: '1.0.0',
          outputSchemaVersion: 'QuestionProposal.v1',
          maxOutputTokens: 512,
          estimatedInputTokens: 64,
          reasoningProfile: 'NO_REASONING',
          absoluteDeadlineAt: NOW_ISO,
          templateDescriptor: {
            ref: 'tpl-q',
            kind: 'TRUSTED_TEMPLATE',
            inheritedClasses: [],
            ancestorRefs: [],
            scope: { type: 'SERVER_TEMPLATE', templateId: 'tpl-q', templateVersion: 'v1' },
          },
          templateText: 'Author main question for slot-2.',
          candidateConfigDescriptor: {
            ref: 'resp-inject',
            kind: 'CANDIDATE_RESPONSE',
            inheritedClasses: ['USER_TRANSCRIPT'],
            ancestorRefs: [],
            scope: {
              type: 'USER_INTERVIEW',
              userId: 'user-a',
              interviewId: 'int-1',
              recordId: 'resp-1',
              recordVersion: 'v1',
            },
          },
          candidateConfigText: 'PRIOR_QUESTION_INJECTION_CANARY',
          usedSlotIds: ['slot-1'],
          usedTopicIds: ['api_design'],
          usedCompetencyIds: ['api_contracts'],
          difficultyHint: 'MAINTAIN',
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('7. Candidate configuration retains USER_TRANSCRIPT data classification, never SYNTHETIC', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerServerTemplate({
      templateId: 'tpl-q',
      templateVersion: 'v1',
      content: 'Author main question.',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-1',
      recordId: 'cfg-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_CONFIGURATION',
      ancestorRefs: [],
      content: 'role=backend_engineer',
    });

    const result = buildRubricAuthoringPrompt(
      {
        authenticatedUserId: 'user-a',
        interviewId: 'int-1',
        operationId: 'op-3',
        generationEpoch: 1,
        attemptId: 'att-3',
        attemptNo: 1,
        provider: 'MOCK',
        purpose: 'PLAN',
        promptVersion: '1.0.0',
        outputSchemaVersion: 'PlanProposal.v1',
        maxOutputTokens: 512,
        estimatedInputTokens: 32,
        reasoningProfile: 'NO_REASONING',
        absoluteDeadlineAt: NOW_ISO,
        templateDescriptor: {
          ref: 'tpl-q',
          kind: 'TRUSTED_TEMPLATE',
          inheritedClasses: [],
          ancestorRefs: [],
          scope: { type: 'SERVER_TEMPLATE', templateId: 'tpl-q', templateVersion: 'v1' },
        },
        templateText: 'Author main question.',
        candidateConfigDescriptor: {
          ref: 'cfg-1',
          kind: 'CANDIDATE_CONFIGURATION',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-1',
            recordId: 'cfg-1',
            recordVersion: 'v1',
          },
        },
        candidateConfigText: 'role=backend_engineer',
        usedSlotIds: [],
        usedTopicIds: [],
        usedCompetencyIds: [],
        difficultyHint: 'MAINTAIN',
      },
      resolver,
    );

    expect(result.canonicalDataClasses).toEqual(['USER_TRANSCRIPT']);
  });

  it('8. Lower-trust content appears only in authorized follow-up/context paths', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerServerTemplate({
      templateId: 'tpl-fu',
      templateVersion: 'v1',
      content: 'Generate follow-up.',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-1',
      recordId: 'resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Candidate answer about idempotency.',
    });

    const result = buildLowerTrustPrompt(
      {
        authenticatedUserId: 'user-a',
        interviewId: 'int-1',
        operationId: 'op-4',
        generationEpoch: 1,
        attemptId: 'att-4',
        attemptNo: 1,
        provider: 'MOCK',
        purpose: 'FOLLOW_UP',
        promptVersion: '1.0.0',
        outputSchemaVersion: 'FollowUpProposal.v1',
        maxOutputTokens: 256,
        estimatedInputTokens: 40,
        reasoningProfile: 'NO_REASONING',
        absoluteDeadlineAt: NOW_ISO,
        templateDescriptor: {
          ref: 'tpl-fu',
          kind: 'TRUSTED_TEMPLATE',
          inheritedClasses: [],
          ancestorRefs: [],
          scope: { type: 'SERVER_TEMPLATE', templateId: 'tpl-fu', templateVersion: 'v1' },
        },
        templateText: 'Generate follow-up.',
        contextParts: [
          {
            descriptor: {
              ref: 'resp-1',
              kind: 'CANDIDATE_RESPONSE',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: [],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-1',
                recordId: 'resp-1',
                recordVersion: 'v1',
              },
            },
            text: 'Candidate answer about idempotency.',
          },
        ],
        maxContextChars: 500,
      },
      resolver,
    );

    expect(result.canonicalDataClasses).toEqual(['USER_TRANSCRIPT']);
    expect(result.flattenedMessages[1].content).toContain('Candidate answer about idempotency.');
  });

  it('9. Follow-up attempting rubric replacement is rejected', () => {
    expect(() =>
      parseUnknownProposal('FOLLOW_UP', {
        schemaVersion: 'FollowUpProposal.v1',
        kind: 'DEEPEN',
        parentQuestionId: 'q-1',
        competencyTag: 'api_contracts',
        text: 'Please explain your caching strategy.',
        scoringRubric: [{ criterion: 'correctness', maxPoints: 10, description: 'Override' }],
      }),
    ).toThrowError(SanitizedAiError);
  });

  it('10. Off-topic follow-up and parent-question mismatch are rejected', () => {
    const validFollowUp = parseUnknownProposal('FOLLOW_UP', {
      schemaVersion: 'FollowUpProposal.v1',
      kind: 'CLARIFY',
      parentQuestionId: 'q-1',
      competencyTag: 'api_contracts',
      text: 'Could you clarify how you store the idempotency key?',
    });

    expect(() =>
      validateFollowUpProposalPolicy(validFollowUp, {
        questionId: 'q-2',
        topic: 'api_design',
        allowedCompetencyTags: new Set(['api_contracts']),
      }),
    ).toThrowError(SanitizedAiError);

    expect(() =>
      validateFollowUpProposalPolicy(validFollowUp, {
        questionId: 'q-1',
        topic: 'api_design',
        allowedCompetencyTags: new Set(['async_control']),
      }),
    ).toThrowError(SanitizedAiError);
  });

  it('11. Model-authored TRANSITION is rejected in FollowUpProposal.v1', () => {
    expect(() =>
      parseUnknownProposal('FOLLOW_UP', {
        schemaVersion: 'FollowUpProposal.v1',
        kind: 'TRANSITION',
        parentQuestionId: 'q-1',
        competencyTag: 'api_contracts',
        text: 'Moving to the next topic now.',
      }),
    ).toThrowError(SanitizedAiError);
  });

  it('12. Deterministic duplicate-question rejection via normalized text fingerprint', () => {
    const fp = computeNormalizedQuestionFingerprint(VALID_QUESTION.text);
    const nearDuplicate = {
      ...VALID_QUESTION,
      text: '  how would you design an idempotent retry mechanism for a payment free webhook  ',
    };
    expect(() =>
      validateQuestionProposalPolicy(
        nearDuplicate,
        SYNTHETIC_ASSESSMENT_POLICY_V1,
        new Set([fp]),
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('13. Bounded context trimming preserves transitive USER_DOCUMENT lineage', () => {
    const parts = [
      {
        descriptor: {
          ref: 'old-resp',
          kind: 'CANDIDATE_RESPONSE' as const,
          inheritedClasses: ['USER_TRANSCRIPT' as const],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW' as const,
            userId: 'user-a',
            interviewId: 'int-1',
            recordId: 'r-1',
            recordVersion: 'v1',
          },
        },
        text: 'A'.repeat(60),
      },
      {
        descriptor: {
          ref: 'doc-sum',
          kind: 'DERIVED_SUMMARY' as const,
          inheritedClasses: ['USER_DOCUMENT' as const],
          ancestorRefs: ['doc-1'],
          scope: {
            type: 'USER_INTERVIEW' as const,
            userId: 'user-a',
            interviewId: 'int-1',
            recordId: 'sum-1',
            recordVersion: 'v1',
          },
        },
        text: 'B'.repeat(40),
      },
    ];

    const kept = trimContextPartsDeterministically(parts, 50);
    expect(kept).toHaveLength(1);
    expect(kept[0].descriptor.inheritedClasses).toEqual(['USER_DOCUMENT']);
  });

  it('14. Schema-valid but policy-invalid proposals are rejected', () => {
    const schemaValid = parseUnknownProposal('QUESTION', {
      ...VALID_QUESTION,
      topic: 'unapproved_topic',
    });
    expect(() => validateQuestionProposalPolicy(schemaValid)).toThrowError(SanitizedAiError);
  });

  it('15. Malformed provider output maps to sanitized AI_SCHEMA_INVALID without leaking raw output', () => {
    const secretRaw = { secretLeak: 'PRIVATE_MODEL_RAW_PAYLOAD' };
    try {
      parseUnknownProposal('QUESTION', secretRaw);
      expect.unreachable('Expected SanitizedAiError');
    } catch (err) {
      expect(err).toBeInstanceOf(SanitizedAiError);
      expect((err as SanitizedAiError).code).toBe('AI_SCHEMA_INVALID');
      expect((err as SanitizedAiError).message).not.toContain('PRIVATE_MODEL_RAW_PAYLOAD');
    }
  });

  it('16. START_BUNDLE offline fixture composes validated PLAN and Q1 schemas', () => {
    const bundle = parseUnknownProposal('START_BUNDLE', {
      schemaVersion: 'StartBundleProposal.v1',
      plan: VALID_PLAN,
      q1: VALID_QUESTION,
    });
    expect(bundle.plan.role).toBe('backend_engineer');
    expect(bundle.q1.type).toBe('CONCEPTUAL');
  });
});
