export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface SlidingWindowRateLimiterOptions {
  /** Maximum accepted events per key per window. Zero or negative disables limiting. */
  limit: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Per-key sliding-window limiter used to keep a noisy chat from overwhelming
 * the agent. It is intentionally in-memory: restarting the process resets the
 * window, which is fine for chat protection.
 */
export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, number[]>();

  constructor(options: SlidingWindowRateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = Math.max(1, options.windowMs);
    this.now = options.now ?? Date.now;
  }

  check(key: string): RateLimitDecision {
    if (this.limit <= 0) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const now = this.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (timestamps.length >= this.limit) {
      const oldest = timestamps[0] ?? now;
      this.hits.set(key, timestamps);
      return {
        allowed: false,
        retryAfterMs: Math.max(0, oldest + this.windowMs - now),
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(key?: string): void {
    if (key) {
      this.hits.delete(key);
      return;
    }
    this.hits.clear();
  }

  size(): number {
    return this.hits.size;
  }
}
