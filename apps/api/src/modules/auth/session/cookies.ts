import type { SessionLifetimes } from './types.js';

export const CANDIDATE_IDLE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (604,800s)
export const CANDIDATE_ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days (2,592,000s)

export const ADMIN_IDLE_TTL_SECONDS = 12 * 60 * 60; // 12 hours (43,200s)
export const ADMIN_ABSOLUTE_TTL_SECONDS = 24 * 60 * 60; // 24 hours (86,400s)

export const PROD_REFRESH_COOKIE_NAME = '__Host-roundset_refresh';
export const PROD_CSRF_COOKIE_NAME = '__Host-roundset_csrf';

export const DEV_REFRESH_COOKIE_NAME = 'roundset_refresh';
export const DEV_CSRF_COOKIE_NAME = 'roundset_csrf';

export interface CookieContextOptions {
  isSecure?: boolean;
  isProduction?: boolean;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header || typeof header !== 'string') {
    return cookies;
  }

  const pairs = header.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.substring(0, idx).trim();
    let val = pair.substring(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }

  return cookies;
}

export function extractRefreshCookie(
  cookies: Record<string, string>,
  options: { isProduction?: boolean } = {}
): string | undefined {
  if (options.isProduction) {
    return cookies[PROD_REFRESH_COOKIE_NAME];
  }
  return cookies[PROD_REFRESH_COOKIE_NAME] ?? cookies[DEV_REFRESH_COOKIE_NAME];
}

export function extractCsrfCookie(
  cookies: Record<string, string>,
  options: { isProduction?: boolean } = {}
): string | undefined {
  if (options.isProduction) {
    return cookies[PROD_CSRF_COOKIE_NAME];
  }
  return cookies[PROD_CSRF_COOKIE_NAME] ?? cookies[DEV_CSRF_COOKIE_NAME];
}

export function getCookieNames(options: CookieContextOptions): {
  refreshName: string;
  csrfName: string;
} {
  const useHostPrefix = options.isProduction || options.isSecure;
  return {
    refreshName: useHostPrefix ? PROD_REFRESH_COOKIE_NAME : DEV_REFRESH_COOKIE_NAME,
    csrfName: useHostPrefix ? PROD_CSRF_COOKIE_NAME : DEV_CSRF_COOKIE_NAME,
  };
}

export function computeSessionLifetimes(
  role: 'CANDIDATE' | 'ADMIN',
  now: Date = new Date()
): SessionLifetimes {
  const isCandidate = role === 'CANDIDATE';
  const idleTtlMs =
    (isCandidate ? CANDIDATE_IDLE_TTL_SECONDS : ADMIN_IDLE_TTL_SECONDS) * 1000;
  const absoluteTtlMs =
    (isCandidate ? CANDIDATE_ABSOLUTE_TTL_SECONDS : ADMIN_ABSOLUTE_TTL_SECONDS) * 1000;

  const idleExpiresAt = new Date(now.getTime() + idleTtlMs);
  const absoluteExpiresAt = new Date(now.getTime() + absoluteTtlMs);

  return {
    idleTtlMs,
    absoluteTtlMs,
    idleExpiresAt,
    absoluteExpiresAt,
  };
}

export function computeRemainingCookieTtlSeconds(
  idleExpiresAt: Date,
  absoluteExpiresAt: Date,
  now: Date = new Date()
): number {
  const effectiveExpiryMs = Math.min(
    idleExpiresAt.getTime(),
    absoluteExpiresAt.getTime()
  );
  const remainingMs = effectiveExpiryMs - now.getTime();
  return Math.max(0, Math.floor(remainingMs / 1000));
}

export function serializeRefreshCookie(
  value: string,
  maxAgeSeconds: number,
  options: CookieContextOptions
): string {
  const { refreshName } = getCookieNames(options);
  const secureFlag = options.isProduction || options.isSecure ? '; Secure' : '';

  return `${refreshName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

export function serializeCsrfCookie(
  value: string,
  maxAgeSeconds: number,
  options: CookieContextOptions
): string {
  const { csrfName } = getCookieNames(options);
  const secureFlag = options.isProduction || options.isSecure ? '; Secure' : '';

  // JavaScript-readable: HttpOnly is omitted
  return `${csrfName}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

export function serializeClearCookies(
  options: CookieContextOptions
): [string, string] {
  const { refreshName, csrfName } = getCookieNames(options);
  const secureFlag = options.isProduction || options.isSecure ? '; Secure' : '';

  const clearRefresh = `${refreshName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`;
  const clearCsrf = `${csrfName}=; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`;

  return [clearRefresh, clearCsrf];
}
