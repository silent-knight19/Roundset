import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { HttpError } from '../../../core/errors.js';
import { BoundedPasswordLimiter } from './limiter.js';
import {
  ARGON2_POLICY,
  type Argon2Driver,
  type PasswordLimiterStats,
  type PasswordServiceOptions,
} from './types.js';
import {
  normalizePasswordForHash,
  normalizePasswordForVerification,
  parseAndValidateArgon2Hash,
  type HashParameterBounds,
} from './validation.js';

const defaultDriver: Argon2Driver = {
  hash: (password, options) => argon2.hash(password, options),
  verify: (encodedHash, password) => argon2.verify(encodedHash, password),
};

/**
 * Asynchronous Argon2id password-security service with bounded concurrency,
 * strict input/hash validation, sanitized error handling, and shared-limiter
 * dummy verification.
 *
 * Integration contract for subsequent authentication phases:
 * - One shared `PasswordService` instance must serve all authentication paths
 *   (registration, login, password reset/change, reauth, and dummy verification)
 *   so the 2-active / 8-queued resource ceiling is enforced globally.
 * - Initialize the dummy credential before accepting login traffic (for example
 *   by warming `verifyDummy` during application startup) so the first unknown-account
 *   login attempt does not incur one-time dummy hash generation latency.
 */
export class PasswordService {
  private readonly limiter: BoundedPasswordLimiter;
  private readonly driver: Argon2Driver;
  private readonly hashBounds: HashParameterBounds;
  private dummyHashPromise: Promise<string> | null = null;

  constructor(options: PasswordServiceOptions = {}) {
    this.limiter = new BoundedPasswordLimiter(options.limiter);
    this.driver = options.driver ?? defaultDriver;
    this.hashBounds = {
      maxAllowedMemoryKiB: options.maxAllowedMemoryKiB,
      maxAllowedTimeCost: options.maxAllowedTimeCost,
      maxAllowedParallelism: options.maxAllowedParallelism,
    };
  }

  getLimiterStats(): PasswordLimiterStats {
    return this.limiter.getStats();
  }

  /**
   * Validates, NFC-normalizes, and hashes a password with Argon2id
   * under the shared capacity limiter.
   */
  async hashPassword(rawPassword: unknown): Promise<string> {
    const normalized = normalizePasswordForHash(rawPassword);

    return this.limiter.run(async () => {
      try {
        return await this.driver.hash(normalized, {
          type: argon2.argon2id,
          memoryCost: ARGON2_POLICY.memoryCostKiB,
          timeCost: ARGON2_POLICY.timeCost,
          parallelism: ARGON2_POLICY.parallelism,
          hashLength: ARGON2_POLICY.hashLengthBytes,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          throw err;
        }
        throw new HttpError(500, 'INTERNAL_ERROR', 'Password hashing failed');
      }
    });
  }

  /**
   * Validates input password and stored Argon2id hash parameters,
   * then verifies under the shared capacity limiter.
   */
  async verifyPassword(rawPassword: unknown, encodedHash: unknown): Promise<boolean> {
    const normalized = normalizePasswordForVerification(rawPassword);
    parseAndValidateArgon2Hash(encodedHash, this.hashBounds);

    return this.limiter.run(async () => {
      try {
        return await this.driver.verify(encodedHash as string, normalized);
      } catch (err) {
        if (err instanceof HttpError) {
          throw err;
        }
        throw new HttpError(500, 'INTERNAL_ERROR', 'Password verification failed');
      }
    });
  }

  /**
   * Executes an equivalent-cost Argon2id verification against a lazily initialized
   * dummy hash under the same shared capacity limiter. Always returns `false`.
   */
  async verifyDummy(rawPassword: unknown): Promise<boolean> {
    const normalized = normalizePasswordForVerification(rawPassword);
    const dummyHash = await this.getOrCreateDummyHash();

    return this.limiter.run(async () => {
      try {
        await this.driver.verify(dummyHash, normalized);
        return false;
      } catch (err) {
        if (err instanceof HttpError) {
          throw err;
        }
        throw new HttpError(500, 'INTERNAL_ERROR', 'Password verification failed');
      }
    });
  }

  private getOrCreateDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      const dummySecret = randomBytes(32).toString('base64url');
      this.dummyHashPromise = this.limiter
        .run(() =>
          this.driver.hash(dummySecret, {
            type: argon2.argon2id,
            memoryCost: ARGON2_POLICY.memoryCostKiB,
            timeCost: ARGON2_POLICY.timeCost,
            parallelism: ARGON2_POLICY.parallelism,
            hashLength: ARGON2_POLICY.hashLengthBytes,
          })
        )
        .catch((err) => {
          // Clear cached promise on transient failure so future calls can retry
          this.dummyHashPromise = null;
          if (err instanceof HttpError) {
            throw err;
          }
          throw new HttpError(500, 'INTERNAL_ERROR', 'Dummy credential initialization failed');
        });
    }
    return this.dummyHashPromise;
  }
}

export function createPasswordService(options: PasswordServiceOptions = {}): PasswordService {
  return new PasswordService(options);
}
