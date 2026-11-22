import { z } from 'zod';
import { RequestIdSchema } from './common.js';

export const ApiErrorDetailSchema = z.record(z.string(), z.unknown());

export const ApiErrorPayloadSchema = z.object({
  code: z.string().min(1, 'code must be a non-empty string'),
  message: z.string().min(1, 'message must be a non-empty string'),
  requestId: RequestIdSchema,
  details: ApiErrorDetailSchema.optional(),
});

export const ApiErrorResponseSchema = z.object({
  error: ApiErrorPayloadSchema,
});

export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;
export type ApiErrorPayload = z.infer<typeof ApiErrorPayloadSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
