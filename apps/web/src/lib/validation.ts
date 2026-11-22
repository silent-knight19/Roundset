/**
 * Validates a new password for registration and password-reset according to
 * P2_AUTH_API_CONTRACTS_v1.md §4.3:
 * - 12–128 Unicode code points
 * - Maximum 512 UTF-8 bytes after NFC normalization
 * - Rejection of NUL and control characters
 */
export function validateNewPassword(password: string): string | undefined {
  if (!password) {
    return 'Password is required.';
  }

  const normalized = password.normalize('NFC');

  // Reject NUL and control characters (ASCII 0–31, 127, and C1 controls 128–159)
  for (const char of normalized) {
    const code = char.codePointAt(0);
    if (code !== undefined) {
      if ((code >= 0 && code <= 31) || code === 127 || (code >= 128 && code <= 159)) {
        return 'Password cannot contain control characters.';
      }
    }
  }

  // Count Unicode code points (handles surrogate pairs correctly)
  const codePointCount = Array.from(normalized).length;
  if (codePointCount < 12) {
    return 'Password must be at least 12 characters long.';
  }
  if (codePointCount > 128) {
    return 'Password must be at most 128 characters long.';
  }

  // Maximum 512 UTF-8 bytes
  const byteLength = new TextEncoder().encode(normalized).length;
  if (byteLength > 512) {
    return 'Password must not exceed 512 UTF-8 bytes.';
  }

  return undefined;
}
