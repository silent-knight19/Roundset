import {
  PASSWORD_CONCURRENCY_LIMITS,
  PasswordCapacityError,
  type PasswordLimiterOptions,
  type PasswordLimiterStats,
} from './types.js';

interface QueueEntry {
  grant: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

/**
 * Shared bounded concurrency & queue limiter for Argon2id operations.
 * Enforces:
 * - maxConcurrent active operations (default: 2)
 * - maxQueueSize queued operations (default: 8)
 * - queueTimeoutMs max wait in queue (default: 3,000 ms)
 */
export class BoundedPasswordLimiter {
  private readonly maxConcurrent: number;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;
  private activeCount = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(options: PasswordLimiterOptions = {}) {
    this.maxConcurrent =
      options.maxConcurrent ?? PASSWORD_CONCURRENCY_LIMITS.maxConcurrent;
    this.maxQueueSize =
      options.maxQueueSize ?? PASSWORD_CONCURRENCY_LIMITS.maxQueueSize;
    this.queueTimeoutMs =
      options.queueTimeoutMs ?? PASSWORD_CONCURRENCY_LIMITS.queueTimeoutMs;

    if (this.maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be at least 1');
    }
    if (this.maxQueueSize < 0) {
      throw new RangeError('maxQueueSize must be non-negative');
    }
    if (this.queueTimeoutMs < 1) {
      throw new RangeError('queueTimeoutMs must be at least 1');
    }
  }

  getStats(): PasswordLimiterStats {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
      queueTimeoutMs: this.queueTimeoutMs,
    };
  }

  /**
   * Executes `task` within the bounded concurrency & queue limits.
   * An active slot is held for the full lifetime of the returned promise
   * and released only in `finally`. Timed-out queued tasks never start.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      return await task();
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount += 1;
      return Promise.resolve();
    }

    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(
        new PasswordCapacityError('QUEUE_FULL', 'Password service queue is full')
      );
    }

    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        grant: resolve,
        reject,
        timer: setTimeout(() => {
          if (entry.settled) {
            return;
          }
          entry.settled = true;
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(
            new PasswordCapacityError(
              'QUEUE_TIMEOUT',
              'Password service queue wait timed out'
            )
          );
        }, this.queueTimeoutMs),
        settled: false,
      };

      // Do not keep the Node event loop alive solely for a pending queue timer
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  private releaseSlot(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next || next.settled) {
        continue;
      }
      next.settled = true;
      clearTimeout(next.timer);
      // Transfer the active slot directly to the dequeued waiter
      next.grant();
      return;
    }

    this.activeCount = Math.max(0, this.activeCount - 1);
  }
}
