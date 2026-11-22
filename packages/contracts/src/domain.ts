import { z } from 'zod';

export const PlanCodeSchema = z.enum([
  'FREE',
  'PAID_250',
  'PAID_500',
  'PAID_1000',
  'VIP',
]);

export type PlanCode = z.infer<typeof PlanCodeSchema>;

export const InterviewStatusSchema = z.enum([
  'DRAFT',
  'PREFLIGHT',
  'READY',
  'ACTIVE',
  'RECOVERING',
  'COMPLETED',
  'TERMINATED_INTEGRITY',
  'ABORTED_PREFLIGHT',
  'ABORTED_SYSTEM',
  'EXPIRED',
]);

export type InterviewStatus = z.infer<typeof InterviewStatusSchema>;
