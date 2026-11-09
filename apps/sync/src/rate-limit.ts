/**
 * Counts failures per key in a fixed window, in memory. Successes are never counted, so many
 * legitimate users behind one IP (an office NAT) are not locked out by each other.
 */
export class RateLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    return !!entry && entry.resetAt > now && entry.count >= this.maxFailures;
  }

  fail(key: string, now = Date.now()): void {
    if (this.failures.size > 10_000) this.sweep(now);
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.failures) if (entry.resetAt <= now) this.failures.delete(key);
  }
}
