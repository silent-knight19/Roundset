export const PROD_CSRF_COOKIE_NAME = '__Host-roundset_csrf';
export const DEV_CSRF_COOKIE_NAME = 'roundset_csrf';

/**
 * Determines whether the current browser location is HTTPS.
 * Note: __Host- cookies require Secure (HTTPS) in production browsers.
 */
export function isHttpsOrigin(): boolean {
  if (typeof window === 'undefined' || !window.location) {
    return false;
  }
  return window.location.protocol === 'https:';
}

/**
 * Parses a document.cookie string into a key-value map.
 */
export function parseDocumentCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) {
    return cookies;
  }

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = pair.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }

    let rawValue = pair.slice(eqIndex + 1).trim();
    if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
      rawValue = rawValue.slice(1, -1);
    }

    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }

  return cookies;
}

/**
 * Reads the signed JS-readable CSRF cookie from document.cookie.
 * Never reads or accesses the HttpOnly refresh cookie.
 *
 * On HTTPS origins, strictly reads `__Host-roundset_csrf`.
 * On HTTP loopback development origins, checks `__Host-roundset_csrf` first
 * and falls back to `roundset_csrf`.
 */
export function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const cookies = parseDocumentCookies(document.cookie ?? '');
  const value = isHttpsOrigin()
    ? cookies[PROD_CSRF_COOKIE_NAME]
    : (cookies[PROD_CSRF_COOKIE_NAME] ?? cookies[DEV_CSRF_COOKIE_NAME]);

  if (!value || value.trim().length === 0) {
    return null;
  }

  return value.trim();
}
