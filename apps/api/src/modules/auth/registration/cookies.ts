export const REGISTRATION_COOKIE_POLICY = {
  prodName: '__Host-roundset_reg',
  devName: 'roundset_reg',
  prefix: 'reg1',
  maxAgeSeconds: 900,
} as const;

export interface RegistrationCookieOptions {
  isProduction?: boolean;
  isSecure?: boolean;
}

export interface ParsedRegistrationCookie {
  registrationId: string;
  nonce: string;
}

const TOKEN_SEGMENT_REGEX = /^[A-Za-z0-9_-]{16,128}$/;

export function getRegistrationCookieName(isProduction = false): string {
  return isProduction
    ? REGISTRATION_COOKIE_POLICY.prodName
    : REGISTRATION_COOKIE_POLICY.devName;
}

export function serializeRegistrationCookie(
  registrationId: string,
  nonce: string,
  options: RegistrationCookieOptions = {}
): string {
  const isProduction = options.isProduction ?? false;
  const isSecure = isProduction ? true : (options.isSecure ?? false);
  const name = getRegistrationCookieName(isProduction);
  const value = `${REGISTRATION_COOKIE_POLICY.prefix}.${registrationId}.${nonce}`;

  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${REGISTRATION_COOKIE_POLICY.maxAgeSeconds}`,
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function serializeClearRegistrationCookie(
  options: RegistrationCookieOptions = {}
): string {
  const isProduction = options.isProduction ?? false;
  const isSecure = isProduction ? true : (options.isSecure ?? false);
  const name = getRegistrationCookieName(isProduction);

  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function parseRegistrationCookie(
  cookieHeader: string | undefined,
  options: { isProduction?: boolean } = {}
): ParsedRegistrationCookie | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return null;
  }

  const targetName = getRegistrationCookieName(options.isProduction ?? false);
  const pairs = cookieHeader.split(';');
  let rawValue: string | undefined;

  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const name = pair.slice(0, eqIdx).trim();
    if (name === targetName) {
      rawValue = pair.slice(eqIdx + 1).trim();
      break;
    }
  }

  if (!rawValue) {
    return null;
  }

  const segments = rawValue.split('.');
  if (segments.length !== 3 || segments[0] !== REGISTRATION_COOKIE_POLICY.prefix) {
    return null;
  }

  const registrationId = segments[1] ?? '';
  const nonce = segments[2] ?? '';

  if (!TOKEN_SEGMENT_REGEX.test(registrationId) || !TOKEN_SEGMENT_REGEX.test(nonce)) {
    return null;
  }

  return { registrationId, nonce };
}
