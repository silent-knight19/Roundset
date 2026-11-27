import { z } from 'zod';
import { SanitizedAiError } from '../contracts.js';

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const InterviewDifficultySchema = z.enum(['EASY', 'MEDIUM', 'HARD']);
export const InterviewModeSchema = z.enum(['TEXT', 'VOICE']);
/** CODING is reserved for Phase 8; excluded from Phase 4 allowed question types. */
export const Phase4QuestionTypeSchema = z.enum(['CONCEPTUAL', 'SYSTEM_DESIGN', 'BEHAVIORAL']);

export const PlanSlotSchema = z
  .object({
    slotId: IdentifierSchema,
    topic: IdentifierSchema,
    competency: IdentifierSchema,
    weight: z.number().int().min(1).max(100),
    questionType: Phase4QuestionTypeSchema,
    difficulty: InterviewDifficultySchema,
  })
  .strict();

export const PlanProposalV1Schema = z
  .object({
    schemaVersion: z.literal('PlanProposal.v1'),
    role: IdentifierSchema,
    track: IdentifierSchema,
    mode: InterviewModeSchema,
    difficulty: InterviewDifficultySchema,
    durationMinutes: z.number().int().min(5).max(120),
    allowedQuestionTypes: z.array(Phase4QuestionTypeSchema).min(1).max(3),
    slots: z.array(PlanSlotSchema).min(1).max(20),
  })
  .strict();

export type PlanProposalV1 = z.infer<typeof PlanProposalV1Schema>;

export const RubricCriterionSchema = z
  .object({
    criterion: IdentifierSchema,
    maxPoints: z.number().int().min(1).max(10),
    description: z.string().trim().min(5).max(300),
  })
  .strict();

export const QuestionProposalV1Schema = z
  .object({
    schemaVersion: z.literal('QuestionProposal.v1'),
    type: Phase4QuestionTypeSchema,
    topic: IdentifierSchema,
    difficulty: InterviewDifficultySchema,
    text: z.string().trim().min(10).max(1200),
    expectedConcepts: z.array(IdentifierSchema).min(1).max(10),
    scoringRubric: z.array(RubricCriterionSchema).min(1).max(5),
  })
  .strict();

export type QuestionProposalV1 = z.infer<typeof QuestionProposalV1Schema>;

/** Closed to CLARIFY | DEEPEN | CHALLENGE. TRANSITION is explicitly excluded. */
export const FollowUpKindSchema = z.enum(['CLARIFY', 'DEEPEN', 'CHALLENGE']);

export const FollowUpProposalV1Schema = z
  .object({
    schemaVersion: z.literal('FollowUpProposal.v1'),
    kind: FollowUpKindSchema,
    parentQuestionId: IdentifierSchema,
    competencyTag: IdentifierSchema,
    text: z.string().trim().min(10).max(800),
  })
  .strict();

export type FollowUpProposalV1 = z.infer<typeof FollowUpProposalV1Schema>;

export const ContextSummaryProposalV1Schema = z
  .object({
    schemaVersion: z.literal('ContextSummaryProposal.v1'),
    summaryText: z.string().trim().min(1).max(2000),
    coveredTurns: z.number().int().min(1).max(50),
    keyTopics: z.array(IdentifierSchema).min(1).max(10),
  })
  .strict();

export type ContextSummaryProposalV1 = z.infer<typeof ContextSummaryProposalV1Schema>;

/**
 * Offline-fixture-only composition of PlanProposal.v1 and Q1 QuestionProposal.v1.
 * Not approved as a live-call optimization without separate verification.
 */
export const StartBundleProposalV1Schema = z
  .object({
    schemaVersion: z.literal('StartBundleProposal.v1'),
    plan: PlanProposalV1Schema,
    q1: QuestionProposalV1Schema,
  })
  .strict();

export type StartBundleProposalV1 = z.infer<typeof StartBundleProposalV1Schema>;

export type ProposalPurpose = 'PLAN' | 'QUESTION' | 'FOLLOW_UP' | 'CONTEXT_SUMMARY' | 'START_BUNDLE';

export function parseUnknownProposal(purpose: 'PLAN', raw: unknown): PlanProposalV1;
export function parseUnknownProposal(purpose: 'QUESTION', raw: unknown): QuestionProposalV1;
export function parseUnknownProposal(purpose: 'FOLLOW_UP', raw: unknown): FollowUpProposalV1;
export function parseUnknownProposal(
  purpose: 'CONTEXT_SUMMARY',
  raw: unknown,
): ContextSummaryProposalV1;
export function parseUnknownProposal(purpose: 'START_BUNDLE', raw: unknown): StartBundleProposalV1;
export function parseUnknownProposal(purpose: ProposalPurpose, raw: unknown): unknown {
  const schemaMap = {
    PLAN: PlanProposalV1Schema,
    QUESTION: QuestionProposalV1Schema,
    FOLLOW_UP: FollowUpProposalV1Schema,
    CONTEXT_SUMMARY: ContextSummaryProposalV1Schema,
    START_BUNDLE: StartBundleProposalV1Schema,
  } as const;

  const result = schemaMap[purpose].safeParse(raw);
  if (!result.success) {
    throw new SanitizedAiError(
      'AI_SCHEMA_INVALID',
      `Model output failed ${purpose} schema validation`,
    );
  }
  return result.data;
}
