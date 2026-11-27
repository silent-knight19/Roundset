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

function isDisallowedPolicyPlaceholder(val: string | undefined, defaultVal: string): boolean {
  if (!val || val.trim().length === 0) return true;
  const lower = val.trim().toLowerCase();
  if (lower === defaultVal.toLowerCase()) return true;
  if (lower.includes('placeholder')) return true;
  if (lower === 'test' || lower.startsWith('test-') || lower.startsWith('test_')) return true;
  if (lower === 'dev' || lower.startsWith('dev-') || lower.startsWith('dev_')) return true;
  if (lower === 'default' || lower.startsWith('default-') || lower.startsWith('default_')) return true;
  if (lower === 'example' || lower.startsWith('example-') || lower.startsWith('example_')) return true;
  return false;
}

export const RetiredJwtKeySchema = z
  .object({
    kid: z.string().min(1),
    publicKeyPem: z.string().min(1),
  })
  .strict();
export type RetiredJwtKey = z.infer<typeof RetiredJwtKeySchema>;

export const RetiredRefreshKeySchema = z
  .object({
    kid: z.string().min(1),
    hmacSecret: z.string().min(32),
    digestSecret: z.string().min(32),
  })
  .strict();
export type RetiredRefreshKey = z.infer<typeof RetiredRefreshKeySchema>;

export const RetiredCsrfKeySchema = z
  .object({
    kid: z.string().min(1),
    hmacSecret: z.string().min(32),
  })
  .strict();
export type RetiredCsrfKey = z.infer<typeof RetiredCsrfKeySchema>;

const parseJsonArray = <T>(itemSchema: z.ZodType<T>) =>
  z.preprocess((val) => {
    if (typeof val === 'string' && val.trim().length > 0) {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val === '' ? undefined : val;
  }, z.array(itemSchema).max(10).optional());

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

    // Local password-auth integration remains opt-in. Never enable mock email in production.
    AUTH_DEV_MOCK_EMAIL: z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
      .default(false).transform(value => value === true || value === 'true' || value === '1'),
    AUTH_CHALLENGE_HMAC_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'Expected a 32-byte hex key').optional(),

    // Cryptographic keys
    JWT_ISSUER: z.string().min(1).default('roundset-auth'),
    JWT_AUDIENCE: z.string().min(1).default('roundset-api'),
    JWT_ACTIVE_KID: z.string().min(1).default('jwt-k1'),
    JWT_PRIVATE_KEY_PEM: z.string().min(1).optional(),
    JWT_PUBLIC_KEY_PEM: z.string().min(1).optional(),
    JWT_RETIRED_KEYS_JSON: parseJsonArray(RetiredJwtKeySchema),

    REFRESH_ACTIVE_KID: z.string().min(1).default('ref-k1'),
    REFRESH_HMAC_KEY: z.string().min(32).optional(),
    REFRESH_DIGEST_KEY: z.string().min(32).optional(),
    REFRESH_RETIRED_KEYS_JSON: parseJsonArray(RetiredRefreshKeySchema),

    CSRF_ACTIVE_KID: z.string().min(1).default('csrf-k1'),
    CSRF_HMAC_KEY: z.string().min(32).optional(),
    CSRF_RETIRED_KEYS_JSON: parseJsonArray(RetiredCsrfKeySchema),
  })
  .superRefine((data, ctx) => {
    if (data.AUTH_DEV_MOCK_EMAIL && !isIsolatedMockAuthConfig(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AUTH_DEV_MOCK_EMAIL'], message: 'Mock auth requires loopback roundset_test replica set, loopback web origin, and distinct explicit 32-byte hex keys' });
    }
    // R2-01: Keyring collision and duplicate key validation (all environments)
    if (data.JWT_RETIRED_KEYS_JSON) {
      const seenJwtKids = new Set<string>();
      for (const item of data.JWT_RETIRED_KEYS_JSON) {
        if (item.kid === data.JWT_ACTIVE_KID) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Retired JWT key ID "${item.kid}" collides with active key ID`,
            path: ['JWT_RETIRED_KEYS_JSON'],
          });
        }
        if (seenJwtKids.has(item.kid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate retired JWT key ID "${item.kid}"`,
            path: ['JWT_RETIRED_KEYS_JSON'],
          });
        }
        seenJwtKids.add(item.kid);
      }
    }

    if (data.REFRESH_RETIRED_KEYS_JSON) {
      const seenRefreshKids = new Set<string>();
      for (const item of data.REFRESH_RETIRED_KEYS_JSON) {
        if (item.kid === data.REFRESH_ACTIVE_KID) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Retired refresh key ID "${item.kid}" collides with active key ID`,
            path: ['REFRESH_RETIRED_KEYS_JSON'],
          });
        }
        if (seenRefreshKids.has(item.kid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate retired refresh key ID "${item.kid}"`,
            path: ['REFRESH_RETIRED_KEYS_JSON'],
          });
        }
        seenRefreshKids.add(item.kid);
        if (item.hmacSecret === item.digestSecret) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Retired refresh HMAC integrity and digest keys must be distinct for kid "${item.kid}"`,
            path: ['REFRESH_RETIRED_KEYS_JSON'],
          });
        }
      }
    }

    if (data.CSRF_RETIRED_KEYS_JSON) {
      const seenCsrfKids = new Set<string>();
      for (const item of data.CSRF_RETIRED_KEYS_JSON) {
        if (item.kid === data.CSRF_ACTIVE_KID) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Retired CSRF key ID "${item.kid}" collides with active key ID`,
            path: ['CSRF_RETIRED_KEYS_JSON'],
          });
        }
        if (seenCsrfKids.has(item.kid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate retired CSRF key ID "${item.kid}"`,
            path: ['CSRF_RETIRED_KEYS_JSON'],
          });
        }
        seenCsrfKids.add(item.kid);
      }
    }

    if (data.NODE_ENV === 'production') {
      if (data.AUTH_DEV_MOCK_EMAIL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mock email is forbidden in production', path: ['AUTH_DEV_MOCK_EMAIL'] });
      }
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

      // R5 / R2-04: Explicit approved policy configuration required in production (no placeholders)
      if (isDisallowedPolicyPlaceholder(data.POLICY_ID, 'roundset-terms-privacy')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Explicit approved POLICY_ID is required in production environment (placeholders forbidden)',
          path: ['POLICY_ID'],
        });
      }

      if (isDisallowedPolicyPlaceholder(data.POLICY_CONSENT_VERSION, '2026-11-22')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Explicit approved POLICY_CONSENT_VERSION is required in production environment (placeholders forbidden)',
          path: ['POLICY_CONSENT_VERSION'],
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

/** Deliberately narrow opt-in; never route mock verification to a shared database. */
export function isIsolatedMockAuthConfig(config: AppConfig): boolean {
  const keys = [config.AUTH_CHALLENGE_HMAC_KEY, config.REFRESH_HMAC_KEY,
    config.REFRESH_DIGEST_KEY, config.CSRF_HMAC_KEY];
  return config.AUTH_DEV_MOCK_EMAIL && config.NODE_ENV !== 'production' &&
    config.INGRESS_MODE === 'LOCAL' && !config.MOCK_DATABASE && config.TRUST_PROXY_HOPS === 0 &&
    /^mongodb:\/\/127\.0\.0\.1:\d{1,5}\/roundset_test\?replicaSet=rs0$/.test(config.MONGODB_URI ?? '') &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(config.WEB_ORIGIN) &&
    keys.every(key => typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key)) &&
    new Set(keys.map(key => key?.toLowerCase())).size === keys.length &&
    !config.REFRESH_RETIRED_KEYS_JSON?.length && !config.CSRF_RETIRED_KEYS_JSON?.length &&
    !config.JWT_RETIRED_KEYS_JSON?.length;
}
