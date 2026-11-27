import { RateLimitExceededError } from './types.js';

interface CounterWindow {
  count: number;
  windowEndMs: number;
}

export interface FloodShedderOptions {
  perIpLimitPerMinute?: number;
  globalLimitPerMinute?: number;
  windowMs?: number;
  maxTrackedIps?: number;
  now?: () => number;
}

/**
 * Bounded in-process pre-database flood shedder (60/min per trusted IP,
 * 120/min globally per process). Uses a capped Map so attacker-controlled
 * inputs cannot cause unbounded memory growth.
 */
export class InProcessFloodShedder {
  private readonly perIpLimit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
  private readonly maxTrackedIps: number;
  private readonly now: () => number;

  private globalWindow: CounterWindow;
  private readonly ipWindows = new Map<string, CounterWindow>();

  constructor(options: FloodShedderOptions = {}) {
    this.perIpLimit = options.perIpLimitPerMinute ?? 60;
    this.globalLimit = options.globalLimitPerMinute ?? 120;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxTrackedIps = options.maxTrackedIps ?? 2_048;
    this.now = options.now ?? (() => Date.now());
    this.globalWindow = { count: 0, windowEndMs: this.now() + this.windowMs };
  }

  getTrackedIpCount(): number {
    return this.ipWindows.size;
  }

  consumeOrThrow(trustedIp: string): void {
    const currentNow = this.now();
    const ipKey = trustedIp.trim() || 'unknown';

    // 1. Global per-process limit
    if (currentNow >= this.globalWindow.windowEndMs) {
      this.globalWindow = { count: 0, windowEndMs: currentNow + this.windowMs };
    }
    if (this.globalWindow.count >= this.globalLimit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((this.globalWindow.windowEndMs - currentNow) / 1000)
      );
      throw new RateLimitExceededError(retryAfter, 'RATE_LIMITED');
    }

    // 2. Per-trusted-IP limit
    let ipEntry = this.ipWindows.get(ipKey);
    if (!ipEntry || currentNow >= ipEntry.windowEndMs) {
      if (!ipEntry && this.ipWindows.size >= this.maxTrackedIps) {
        this.evictOldestOrExpired(currentNow);
      }
      ipEntry = { count: 0, windowEndMs: currentNow + this.windowMs };
      this.ipWindows.set(ipKey, ipEntry);
    }

    if (ipEntry.count >= this.perIpLimit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((ipEntry.windowEndMs - currentNow) / 1000)
      );
      throw new RateLimitExceededError(retryAfter, 'RATE_LIMITED');
    }

    this.globalWindow.count += 1;
    ipEntry.count += 1;
  }

  private evictOldestOrExpired(currentNow: number): void {
    for (const [key, entry] of this.ipWindows.entries()) {
      if (currentNow >= entry.windowEndMs) {
        this.ipWindows.delete(key);
        return;
      }
    }
    const oldestKey = this.ipWindows.keys().next().value;
    if (oldestKey !== undefined) {
      this.ipWindows.delete(oldestKey);
    }
  }
}
