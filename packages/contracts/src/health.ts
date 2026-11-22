import { z } from 'zod';
import { ResponseMetaSchema } from './common.js';

export const LivenessDataSchema = z.object({
  status: z.literal('ok'),
  version: z.string().min(1, 'version must be a non-empty string'),
});

export const LivenessResponseSchema = z.object({
  data: LivenessDataSchema,
  meta: ResponseMetaSchema,
});

export type LivenessData = z.infer<typeof LivenessDataSchema>;
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

export const ReadinessDataSchema = z.object({
  ready: z.boolean(),
});

export const ReadinessResponseSchema = z.object({
  data: ReadinessDataSchema,
  meta: ResponseMetaSchema,
});

export type ReadinessData = z.infer<typeof ReadinessDataSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
