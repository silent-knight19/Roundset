import { HttpError } from '../../../core/errors.js';

/**
 * Mandatory Argon2id cost policy for Roundset Phase 2 authentication.
 * - Memory cost: 19 MiB (19,456 KiB)
 * - Time cost: 2 iterations
 * - Parallelism: 1 lane
 */
export const ARGON2_POLICY = {
  algorithm: 'argon2id' as const,
  version: 19,
  memoryCostKiB: 19_456,
  timeCost: 2,
  parallelism: 1,
  saltLengthBytes: 16,
  hashLengthBytes: 32,
} as const;

export const PASSWORD_LIMITS = {
  minCodePoints: 12,
  maxCodePoints: 128,
  maxUtf8Bytes: 512,
} as const;

export const PASSWORD_CONCURRENCY_LIMITS = {
  maxConcurrent: 2,
  maxQueueSize: 8,
  queueTimeoutMs: 3_000,
} as const;

export interface ParsedArgon2Hash {
  algorithm: 'argon2id';
  version: number;
  memoryCostKiB: number;
  timeCost: number;
  parallelism: number;
  saltBase64: string;
  hashBase64: string;
}

export interface PasswordLimiterStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}

export interface PasswordLimiterOptions {
  maxConcurrent?: number;
  maxQueueSize?: number;
  queueTimeoutMs?: number;
}

export interface Argon2Driver {
  hash(
    password: string,
    options: {
      type: 0 | 1 | 2;
      memoryCost: number;
      timeCost: number;
      parallelism: number;
      hashLength: number;
    }
  ): Promise<string>;
  verify(encodedHash: string, password: string): Promise<boolean>;
}

export interface PasswordServiceOptions {
  limiter?: PasswordLimiterOptions;
  driver?: Argon2Driver;
  maxAllowedMemoryKiB?: number;
  maxAllowedTimeCost?: number;
  maxAllowedParallelism?: number;
}

/**
 * Controlled capacity error thrown when the password limiter's
 * queue is full or a queued operation exceeds the wait timeout.
 */
export class PasswordCapacityError extends HttpError {
  constructor(
    public readonly reason: 'QUEUE_FULL' | 'QUEUE_TIMEOUT',
    message = 'Password service capacity exceeded'
  ) {
    super(503, 'CAPACITY_UNAVAILABLE', message);
  }
}

/**
 * Sanitized error thrown when a stored encoded hash is malformed
 * or violates the approved Argon2id cost policy.
 */
export class PasswordHashPolicyError extends HttpError {
  constructor(message = 'Stored password hash is invalid or violates policy') {
    super(500, 'INTERNAL_ERROR', message);
  }
}
