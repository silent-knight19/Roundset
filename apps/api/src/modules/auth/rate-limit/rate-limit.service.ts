import type { Model } from 'mongoose';
import type { IAuthRateLimit } from '../../identity/models/auth-rate-limit.model.js';
import { computeDomainHmac } from '../otp/crypto.js';
import {
  RATE_LIMIT_POLICIES,
  RateLimitExceededError,
  type RateLimitPolicyName,
} from './types.js';

export interface AuthRateLimitServiceOptions {
  rateLimitModel: Model<IAuthRateLimit>;
  hmacSecret: string;
  now?: () => Date;
}

export interface RateLimitConsumeResult {
  count: number;
  remaining: number;
  windowEnd: Date;
}

export class AuthRateLimitService {
  private readonly rateLimitModel: Model<IAuthRateLimit>;
  private readonly hmacSecret: string;
  private readonly now: () => Date;
  private readonly loginReservations = new WeakMap<RateLimitConsumeResult, {
    bucketKey: string;
    windowEndMs: number;
  }>();

  constructor(options: AuthRateLimitServiceOptions) {
    this.rateLimitModel = options.rateLimitModel;
    this.hmacSecret = options.hmacSecret;
    this.now = options.now ?? (() => new Date());
  }

  computeBucketKey(policyName: RateLimitPolicyName, subjectKey: string): string {
    return computeDomainHmac(this.hmacSecret, ['RATE_LIMIT', policyName, subjectKey]);
  }

  /**
   * Atomically consumes 1 slot in the persistent MongoDB rate-limit bucket.
   * Handles concurrent duplicate-key/upsert races and expired windows.
   */
  async consumeOrThrow(
    policyName: RateLimitPolicyName,
    subjectKey: string
  ): Promise<RateLimitConsumeResult> {
    try {
      return await this.executeConsume(policyName, subjectKey);
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        throw err;
      }
      throw new RateLimitExceededError(1, RATE_LIMIT_POLICIES[policyName].errorCode ?? 'AUTH_RATE_LIMITED');
    }
  }

  /**
   * Reserve a failure slot before password comparison, including dummy
   * comparisons. Concurrent guesses cannot exceed the persistent cap.
   * A successfully proven password may return only its own reservation.
   */
  async reserveLoginAttempt(emailNormalized: string): Promise<RateLimitConsumeResult> {
    const result = await this.consumeOrThrow('LOGIN_FAIL_EMAIL', emailNormalized);
    this.loginReservations.set(result, {
      bucketKey: this.computeBucketKey('LOGIN_FAIL_EMAIL', emailNormalized),
      windowEndMs: result.windowEnd.getTime(),
    });
    return result;
  }

  async releaseProvenLoginAttempt(reservation: RateLimitConsumeResult): Promise<boolean> {
    const metadata = this.loginReservations.get(reservation);
    if (!metadata) return false;
    // Never retry an uncertain refund: a double decrement could admit
    // additional guesses. A failed or lost refund remains conservative.
    this.loginReservations.delete(reservation);
    try {
      const updated = await this.rateLimitModel.findOneAndUpdate(
        {
          bucketKey: metadata.bucketKey,
          windowEnd: new Date(metadata.windowEndMs),
          count: { $gt: 0 },
        },
        { $inc: { count: -1 } },
        { new: true }
      ).exec();
      return Boolean(updated);
    } catch {
      return false;
    }
  }

  private async executeConsume(
    policyName: RateLimitPolicyName,
    subjectKey: string
  ): Promise<RateLimitConsumeResult> {
    const policy = RATE_LIMIT_POLICIES[policyName];
    const bucketKey = this.computeBucketKey(policyName, subjectKey);
    const currentNow = this.now();
    const newWindowEnd = new Date(currentNow.getTime() + policy.windowMs);
    const newExpiresAt = new Date(newWindowEnd.getTime() + 60_000);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      // 1. Try atomic increment on an active, under-limit window
      const incremented = await this.rateLimitModel
        .findOneAndUpdate(
          {
            bucketKey,
            windowEnd: { $gt: currentNow },
            count: { $lt: policy.limit },
          },
          {
            $inc: { count: 1 },
          },
          { new: true }
        )
        .exec();

      if (incremented) {
        return {
          count: incremented.count,
          remaining: Math.max(0, policy.limit - incremented.count),
          windowEnd: incremented.windowEnd,
        };
      }

      // 2. Check if an active window is already at/over limit
      const active = await this.rateLimitModel
        .findOne({
          bucketKey,
          windowEnd: { $gt: currentNow },
        })
        .exec();

      if (active) {
        // A proven login may have refunded a slot after the failed increment.
        if (active.count < policy.limit) continue;
        const retryAfter = Math.max(
          1,
          Math.ceil((active.windowEnd.getTime() - currentNow.getTime()) / 1000)
        );
        throw new RateLimitExceededError(
          retryAfter,
          policy.errorCode ?? 'RATE_LIMITED'
        );
      }

      // 3. Reset expired window or create new bucket
      const reset = await this.rateLimitModel
        .findOneAndUpdate(
          {
            bucketKey,
            windowEnd: { $lte: currentNow },
          },
          {
            $set: {
              count: 1,
              windowEnd: newWindowEnd,
              expiresAt: newExpiresAt,
            },
          },
          { new: true }
        )
        .exec();

      if (reset) {
        return {
          count: reset.count,
          remaining: Math.max(0, policy.limit - reset.count),
          windowEnd: reset.windowEnd,
        };
      }

      try {
        const created = await this.rateLimitModel.create({
          bucketKey,
          count: 1,
          windowEnd: newWindowEnd,
          expiresAt: newExpiresAt,
        });
        return {
          count: created.count,
          remaining: Math.max(0, policy.limit - created.count),
          windowEnd: created.windowEnd,
        };
      } catch (err: unknown) {
        const code = (err as { code?: number })?.code;
        if (code === 11000) {
          continue;
        }
        throw err;
      }
    }

    throw new RateLimitExceededError(1, policy.errorCode ?? 'RATE_LIMITED');
  }
}
