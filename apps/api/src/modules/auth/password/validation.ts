import {
  PasswordSchema,
  VerificationPasswordSchema,
  hasControlCharacters,
} from '@roundset/contracts';
import { InvalidInputError } from '../../../core/errors.js';
import {
  ARGON2_POLICY,
  PASSWORD_LIMITS,
  PasswordHashPolicyError,
  type ParsedArgon2Hash,
} from './types.js';

const BASE64_UNPADDED_REGEX = /^[A-Za-z0-9+/]+$/;
const MAX_ENCODED_HASH_LENGTH = 512;

export interface HashParameterBounds {
  maxAllowedMemoryKiB?: number;
  maxAllowedTimeCost?: number;
  maxAllowedParallelism?: number;
}

/**
 * Validates and NFC-normalizes a password for creation, registration,
 * password reset, or password change.
 * Never trims or truncates; rejects control characters and out-of-bounds inputs
 * without echoing the password in error messages.
 */
export function normalizePasswordForHash(rawPassword: unknown): string {
  if (typeof rawPassword !== 'string') {
    throw new InvalidInputError('Password must be a string');
  }
  if (hasControlCharacters(rawPassword)) {
    throw new InvalidInputError('Password contains prohibited control characters');
  }

  const parsed = PasswordSchema.safeParse(rawPassword);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new InvalidInputError(firstIssue?.message ?? 'Password does not meet requirements');
  }

  if (hasControlCharacters(parsed.data)) {
    throw new InvalidInputError('Password contains prohibited control characters');
  }

  return parsed.data;
}

/**
 * Validates and NFC-normalizes a password for verification (login / reauth).
 * Rejects non-strings, empty passwords, control characters (including NUL),
 * and inputs exceeding 512 UTF-8 bytes without trimming or truncating.
 */
export function normalizePasswordForVerification(rawPassword: unknown): string {
  if (typeof rawPassword !== 'string') {
    throw new InvalidInputError('Password must be a string');
  }
  if (rawPassword.length === 0) {
    throw new InvalidInputError('Password is required');
  }
  if (hasControlCharacters(rawPassword)) {
    throw new InvalidInputError('Password contains prohibited control characters');
  }

  const parsed = VerificationPasswordSchema.safeParse(rawPassword);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new InvalidInputError(
      firstIssue?.message ?? `Password must not exceed ${PASSWORD_LIMITS.maxUtf8Bytes} UTF-8 bytes`
    );
  }

  if (hasControlCharacters(parsed.data)) {
    throw new InvalidInputError('Password contains prohibited control characters');
  }

  return parsed.data;
}

/**
 * Parses and validates an encoded Argon2id PHC hash string before
 * passing it to native verification.
 * Rejects malformed strings, non-Argon2id algorithms, wrong versions,
 * or cost parameters outside the approved resource policy.
 * Never includes the hash string in error messages.
 */
export function parseAndValidateArgon2Hash(
  encodedHash: unknown,
  bounds: HashParameterBounds = {}
): ParsedArgon2Hash {
  if (
    typeof encodedHash !== 'string' ||
    encodedHash.length === 0 ||
    encodedHash.length > MAX_ENCODED_HASH_LENGTH ||
    hasControlCharacters(encodedHash)
  ) {
    throw new PasswordHashPolicyError('Encoded password hash is malformed');
  }

  const parts = encodedHash.split('$');
  // Expected: ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', '<salt>', '<hash>']
  if (parts.length !== 6 || parts[0] !== '') {
    throw new PasswordHashPolicyError('Encoded password hash format is invalid');
  }

  const [, algorithm, versionPart, paramsPart, saltBase64, hashBase64] = parts;

  if (algorithm !== ARGON2_POLICY.algorithm) {
    throw new PasswordHashPolicyError('Unsupported password hash algorithm');
  }

  if (versionPart !== `v=${ARGON2_POLICY.version}`) {
    throw new PasswordHashPolicyError('Unsupported password hash version');
  }

  if (!paramsPart || !saltBase64 || !hashBase64) {
    throw new PasswordHashPolicyError('Encoded password hash is incomplete');
  }

  const paramSegments = paramsPart.split(',');
  if (paramSegments.length !== 3) {
    throw new PasswordHashPolicyError('Encoded password hash parameters are malformed');
  }

  const mMatch = /^m=(\d+)$/.exec(paramSegments[0] ?? '');
  const tMatch = /^t=(\d+)$/.exec(paramSegments[1] ?? '');
  const pMatch = /^p=(\d+)$/.exec(paramSegments[2] ?? '');

  if (!mMatch?.[1] || !tMatch?.[1] || !pMatch?.[1]) {
    throw new PasswordHashPolicyError('Encoded password hash parameters are malformed');
  }

  const memoryCostKiB = Number.parseInt(mMatch[1], 10);
  const timeCost = Number.parseInt(tMatch[1], 10);
  const parallelism = Number.parseInt(pMatch[1], 10);

  const maxMemoryKiB = bounds.maxAllowedMemoryKiB ?? ARGON2_POLICY.memoryCostKiB;
  const maxTimeCost = bounds.maxAllowedTimeCost ?? ARGON2_POLICY.timeCost;
  const maxParallelism = bounds.maxAllowedParallelism ?? ARGON2_POLICY.parallelism;

  if (
    !Number.isSafeInteger(memoryCostKiB) ||
    memoryCostKiB < ARGON2_POLICY.memoryCostKiB ||
    memoryCostKiB > maxMemoryKiB
  ) {
    throw new PasswordHashPolicyError('Password hash memory cost violates resource policy');
  }

  if (
    !Number.isSafeInteger(timeCost) ||
    timeCost < ARGON2_POLICY.timeCost ||
    timeCost > maxTimeCost
  ) {
    throw new PasswordHashPolicyError('Password hash time cost violates resource policy');
  }

  if (
    !Number.isSafeInteger(parallelism) ||
    parallelism < ARGON2_POLICY.parallelism ||
    parallelism > maxParallelism
  ) {
    throw new PasswordHashPolicyError('Password hash parallelism violates resource policy');
  }

  if (!BASE64_UNPADDED_REGEX.test(saltBase64) || !BASE64_UNPADDED_REGEX.test(hashBase64)) {
    throw new PasswordHashPolicyError('Encoded password hash contains invalid base64');
  }

  const decodedSaltLen = Buffer.from(saltBase64, 'base64').length;
  const decodedHashLen = Buffer.from(hashBase64, 'base64').length;

  if (
    decodedSaltLen < ARGON2_POLICY.saltLengthBytes ||
    decodedHashLen < ARGON2_POLICY.hashLengthBytes
  ) {
    throw new PasswordHashPolicyError('Encoded password hash salt or digest length is invalid');
  }

  return {
    algorithm: 'argon2id',
    version: ARGON2_POLICY.version,
    memoryCostKiB,
    timeCost,
    parallelism,
    saltBase64,
    hashBase64,
  };
}
