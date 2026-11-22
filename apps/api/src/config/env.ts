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

export const IngressModeSchema = z.enum(['LOCAL', 'PAGES_PROXY', 'SINGLE_ORIGIN']);
export type IngressMode = z.infer<typeof IngressModeSchema>;

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

    // Ingress & edge security
    INGRESS_MODE: IngressModeSchema.default('LOCAL'),
    EDGE_AUTH_SECRET_CURRENT: z.string().min(32).optional(),
    EDGE_AUTH_SECRET_PREVIOUS: z.string().min(32).optional(),

    // Policy & meta
    POLICY_ID: z.string().min(1).default('roundset-terms-privacy'),
    POLICY_CONSENT_VERSION: z.string().min(1).default('2026-11-22'),
    REGISTRATION_MODE: z.enum(['PUBLIC', 'INVITE_ONLY']).default('PUBLIC'),

    // Cryptographic keys
    JWT_ISSUER: z.string().min(1).default('roundset-auth'),
    JWT_AUDIENCE: z.string().min(1).default('roundset-api'),
    JWT_ACTIVE_KID: z.string().min(1).default('jwt-k1'),
    JWT_PRIVATE_KEY_PEM: z.string().min(1).optional(),
    JWT_PUBLIC_KEY_PEM: z.string().min(1).optional(),

    REFRESH_ACTIVE_KID: z.string().min(1).default('ref-k1'),
    REFRESH_HMAC_KEY: z.string().min(32).optional(),
    REFRESH_DIGEST_KEY: z.string().min(32).optional(),

    CSRF_ACTIVE_KID: z.string().min(1).default('csrf-k1'),
    CSRF_HMAC_KEY: z.string().min(32).optional(),
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

      // Ingress security in production
      if (data.INGRESS_MODE === 'LOCAL') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'INGRESS_MODE=LOCAL is forbidden in production environment',
          path: ['INGRESS_MODE'],
        });
      }

      if (data.INGRESS_MODE === 'PAGES_PROXY' && !data.EDGE_AUTH_SECRET_CURRENT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'EDGE_AUTH_SECRET_CURRENT is required in PAGES_PROXY production mode',
          path: ['EDGE_AUTH_SECRET_CURRENT'],
        });
      }

      // Mandatory cryptographic keys in production
      if (!data.JWT_PRIVATE_KEY_PEM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'JWT_PRIVATE_KEY_PEM is required in production environment',
          path: ['JWT_PRIVATE_KEY_PEM'],
        });
      }
      if (!data.JWT_PUBLIC_KEY_PEM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'JWT_PUBLIC_KEY_PEM is required in production environment',
          path: ['JWT_PUBLIC_KEY_PEM'],
        });
      }
      if (!data.REFRESH_HMAC_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'REFRESH_HMAC_KEY is required in production environment',
          path: ['REFRESH_HMAC_KEY'],
        });
      }
      if (!data.REFRESH_DIGEST_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'REFRESH_DIGEST_KEY is required in production environment',
          path: ['REFRESH_DIGEST_KEY'],
        });
      }
      if (!data.CSRF_HMAC_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CSRF_HMAC_KEY is required in production environment',
          path: ['CSRF_HMAC_KEY'],
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
