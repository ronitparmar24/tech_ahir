'use strict';

/**
 * Token bucket per key. Keyed by bidder name here; in production it would be
 * keyed by the authenticated user id (and IP) at the API gateway.
 */
class RateLimiter {
  constructor({ perSecond = 8, burst = 16 } = {}) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.buckets = new Map();
    this.sweep = setInterval(() => this.#cleanup(), 30_000);
    this.sweep.unref();
  }

  /** @returns {boolean} true if the request may proceed */
  take(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  #cleanup() {
    const cutoff = Date.now() - 60_000;
    for (const [k, b] of this.buckets) if (b.at < cutoff) this.buckets.delete(k);
  }

  stop() {
    clearInterval(this.sweep);
  }
}

module.exports = { RateLimiter };
