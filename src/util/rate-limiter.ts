// src/util/rate-limiter.ts
//
// Minimal token-bucket rate limiter for outbound API calls. Runtime-agnostic:
// callers pass tokens per op (default 1); `acquire(n)` resolves when the
// bucket has n tokens available. Tokens refill linearly at `ratePerSec`.
//
// Not used by T9's core paths directly; kept as a plumbed utility for
// subsystems (e.g. image-provider bundled server, outbound IM throttling)
// that want a common implementation.

export interface TokenBucketOptions {
  /** Refill rate in tokens per second. */
  ratePerSec: number;
  /** Maximum burst = bucket capacity. Defaults to ratePerSec. */
  capacity?: number;
  /** Clock function — tests inject a fake. */
  now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly rateMs: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity ?? opts.ratePerSec;
    this.rateMs = opts.ratePerSec / 1000;
    this.now = opts.now ?? Date.now;
    this.tokens = this.capacity;
    this.last = this.now();
  }

  /** Available tokens right now, after refilling. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Reserve `n` tokens, waiting (async) until they're available. Resolves
   * immediately if n is 0 or already available.
   */
  async acquire(n = 1, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
    if (n <= 0) return;
    if (n > this.capacity) {
      throw new Error(`TokenBucket.acquire(${n}) exceeds capacity ${this.capacity}`);
    }
    this.refill();
    while (this.tokens < n) {
      const deficit = n - this.tokens;
      const waitMs = Math.ceil(deficit / this.rateMs);
      await sleep(waitMs);
      this.refill();
    }
    this.tokens -= n;
  }

  private refill(): void {
    const t = this.now();
    const dt = Math.max(0, t - this.last);
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.rateMs);
    this.last = t;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}
