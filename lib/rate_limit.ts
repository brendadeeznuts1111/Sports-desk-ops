/**
 * @file lib/rate_limit.ts
 * @description In-memory token bucket rate limiter for pre-worker auth flood protection.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  last: number; // epoch ms of last refill
}

export interface TokenBucketOptions {
  /** Max burst size. */
  capacity: number;
  /** Sustained refill rate, tokens per second. */
  refillPerSec: number;
  /** Drop buckets untouched for this long (ms). Default: 2 × refill window. */
  idleEvictMs?: number;
  /** Sweep interval (ms). Default: 30_000. */
  sweepIntervalMs?: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly idleEvictMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity <= 0 || opts.refillPerSec <= 0) {
      throw new Error(
        "TokenBucketLimiter: capacity and refillPerSec must be > 0",
      );
    }
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    // Default eviction: the time it takes to fully refill an empty bucket, doubled.
    this.idleEvictMs =
      opts.idleEvictMs ??
      Math.ceil((opts.capacity / opts.refillPerSec) * 1000) * 2;

    this.sweepTimer = setInterval(
      () => this.sweep(),
      opts.sweepIntervalMs ?? 30_000,
    );
    // Don't hold the event loop open in tests / CLI scripts.
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Consume one token. `key` is arbitrary — typically `login:${ip}`. */
  check(key: string): RateLimitResult {
    const now = Date.now();
    let b = this.buckets.get(key);

    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.last) / 1000;
      if (elapsedSec > 0) {
        b.tokens = Math.min(
          this.capacity,
          b.tokens + elapsedSec * this.refillPerSec,
        );
        b.last = now;
      }
    }

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(b.tokens),
        retryAfterMs: 0,
      };
    }

    const deficit = 1 - b.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil((deficit / this.refillPerSec) * 1000),
    };
  }

  /** Clear a key (e.g. after a successful login). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** For tests / health probes. */
  size(): number {
    return this.buckets.size;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.idleEvictMs;
    for (const [key, b] of this.buckets) {
      if (b.last < cutoff) this.buckets.delete(key);
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.buckets.clear();
  }
}

/**
 * Login limiter: 10 attempts burst, 10/minute sustained.
 * Sized so a ~200ms argon2id verify cannot starve the worker pool:
 * 10 in-flight + 10/min sustained = ~2 concurrent verifies worst case.
 */
export const loginLimiter = new TokenBucketLimiter({
  capacity: 10,
  refillPerSec: 10 / 60,
});
export const loginKey = (ip: string): string => `login:${ip}`;

if (import.meta.hot) {
  import.meta.hot.dispose(() => loginLimiter.dispose());
}
