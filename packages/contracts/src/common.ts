import { z } from 'zod';

export const RequestIdSchema = z
  .string()
  .min(1, 'requestId must be a non-empty string');

export const ResponseMetaSchema = z.object({
  requestId: RequestIdSchema,
});

export type RequestId = z.infer<typeof RequestIdSchema>;
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;
