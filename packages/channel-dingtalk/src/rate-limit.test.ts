import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "./rate-limit";

describe("SlidingWindowRateLimiter", () => {
  it("allows messages up to the limit and rejects the next one", () => {
    const now = 1_000;
    const limiter = new SlidingWindowRateLimiter({
      limit: 3,
      windowMs: 1_000,
      now: () => now,
    });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    const rejected = limiter.check("a");
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(1_000);
  });

  it("expires old hits and isolates keys", () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter({
      limit: 1,
      windowMs: 100,
      now: () => now,
    });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);

    now = 101;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("is disabled when limit is zero", () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 0, windowMs: 100 });
    for (let index = 0; index < 100; index += 1) {
      expect(limiter.check("a").allowed).toBe(true);
    }
  });
});
