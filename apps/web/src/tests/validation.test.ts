import { describe, it, expect } from 'vitest';
import { validateNewPassword } from '../lib/validation';

describe('validateNewPassword (P2_AUTH_API_CONTRACTS_v1 §4.3)', () => {
  it('rejects empty password', () => {
    expect(validateNewPassword('')).toBe('Password is required.');
  });

  it('rejects 8–11-code-point passwords', () => {
    // 8 code points
    expect(validateNewPassword('Pass1234')).toBe('Password must be at least 12 characters long.');
    // 9 code points
    expect(validateNewPassword('Pass12345')).toBe('Password must be at least 12 characters long.');
    // 10 code points
    expect(validateNewPassword('Pass123456')).toBe('Password must be at least 12 characters long.');
    // 11 code points
    expect(validateNewPassword('Pass1234567')).toBe('Password must be at least 12 characters long.');
  });

  it('accepts valid 12-code-point passwords', () => {
    // Exactly 12 code points
    expect(validateNewPassword('ValidPass123')).toBeUndefined();
    expect(validateNewPassword('CorrectHorse!')).toBeUndefined();
  });

  it('accepts up to 128 Unicode code points', () => {
    const exactly128 = 'A'.repeat(128);
    expect(validateNewPassword(exactly128)).toBeUndefined();

    const tooLong129 = 'A'.repeat(129);
    expect(validateNewPassword(tooLong129)).toBe('Password must be at most 128 characters long.');
  });

  it('rejects control characters (NUL, newline, tabs, DEL)', () => {
    expect(validateNewPassword('Pass\x00word12345')).toBe('Password cannot contain control characters.');
    expect(validateNewPassword('Pass\nword123456')).toBe('Password cannot contain control characters.');
    expect(validateNewPassword('Pass\rword123456')).toBe('Password cannot contain control characters.');
    expect(validateNewPassword('Pass\tword123456')).toBe('Password cannot contain control characters.');
    expect(validateNewPassword('Pass\x7Fword123456')).toBe('Password cannot contain control characters.');
  });

  it('handles multi-byte Unicode code points and byte limit', () => {
    // 12 emoji characters = 12 code points, 48 bytes (< 512 bytes)
    const emojiPassword = '🔒'.repeat(12);
    expect(validateNewPassword(emojiPassword)).toBeUndefined();

    // 11 emoji characters = 11 code points -> rejected for length
    expect(validateNewPassword('🔒'.repeat(11))).toBe('Password must be at least 12 characters long.');
  });
});
