import { z } from 'zod';

/**
 * Sanitizes a database URI or connection string by redacting user credentials.
 */
export function sanitizeUri(rawUri?: string): string {
  if (!rawUri) {
    return '[not-set]';
  }
  return rawUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
}

/**
 * Strict schema for MOCK_DATABASE:
 * Accepts only boolean true/false, string "true"/"false", or string "1"/"0".
 * Rejects any other explicitly supplied value (such as "tru", "enabled", or "").
 * Defaults to false when unset (undefined).
 */
const MockDatabaseSchema = z
  .preprocess(
    (val) => {
      if (val === undefined) {
        return false;
      }
      if (typeof val === 'string') {
        return val.trim().toLowerCase();
      }
      return val;
    },
    z.union([
      z.boolean(),
      z.literal('true'),
      z.literal('false'),
      z.literal('1'),
      z.literal('0'),
    ], {
      error: 'MOCK_DATABASE must be a boolean (true/false) or string ("true"/"false"/"1"/"0")',
    })
  )
  .transform((val) => {
    return val === true || val === 'true' || val === '1';
  });

/**
 * Zod schema for environment variables.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    MOCK_DATABASE: MockDatabaseSchema,
    MONGODB_URI: z.string().min(1).optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (data.MOCK_DATABASE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'MOCK_DATABASE=true is forbidden in production environment',
          path: ['MOCK_DATABASE'],
        });
      }
      if (!data.MONGODB_URI) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'MONGODB_URI is required in production environment',
          path: ['MONGODB_URI'],
        });
      }
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Validates and returns application configuration from environment input.
 * Sanitizes any sensitive error information before throwing.
 */
export function loadEnv(rawEnv: Record<string, unknown> = process.env): AppConfig {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    const formattedErrors = result.error.issues.map((issue) => {
      const fieldPath = issue.path.join('.');
      return `${fieldPath}: ${issue.message}`;
    });
    throw new Error(`Environment validation failed: ${formattedErrors.join('; ')}`);
  }
  return result.data;
}
