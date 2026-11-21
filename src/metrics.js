'use strict';

/** In-process metrics for the System page: throughput, latency, totals. */
class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.ring = Array.from({ length: 60 }, () => ({ sec: -1, count: 0 }));
    this.latencies = new Float64Array(2048);
    this.latencyCount = 0;
    this.accepted = 0;
    this.rejected = 0;
    this.entries = 0;
    this.extensions = 0;
  }

  /** @param {object} result placeBid result  @param {number} micros time spent in the engine */
  recordBid(result, micros) {
    if (result.accepted) {
      this.accepted++;
      this.entries += result.entries.length;
      if (result.extended) this.extensions++;
    } else {
      this.rejected++;
    }
    const sec = Math.floor(Date.now() / 1000);
    const slot = this.ring[sec % 60];
    if (slot.sec !== sec) {
      slot.sec = sec;
      slot.count = 0;
    }
    slot.count++;
    this.latencies[this.latencyCount++ % this.latencies.length] = micros;
  }

  series() {
    const nowSec = Math.floor(Date.now() / 1000);
    const out = [];
    for (let s = nowSec - 59; s <= nowSec; s++) {
      const slot = this.ring[((s % 60) + 60) % 60];
      out.push(slot.sec === s ? slot.count : 0);
    }
    return out;
  }

  latency() {
    const n = Math.min(this.latencyCount, this.latencies.length);
    if (n === 0) return { p50: 0, p99: 0, max: 0 };
    const sorted = Array.from(this.latencies.subarray(0, n)).sort((a, b) => a - b);
    const pick = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
    return { p50: round(pick(0.5)), p99: round(pick(0.99)), max: round(sorted[n - 1]) };
  }

  snapshot(extra = {}) {
    const series = this.series();
    return {
      uptimeMs: Date.now() - this.startedAt,
      bidsPerSecond: series[series.length - 2] ?? 0, // last complete second
      bidsLastMinute: series.reduce((s, x) => s + x, 0),
      series,
      totals: { accepted: this.accepted, rejected: this.rejected, entries: this.entries, extensions: this.extensions },
      latencyMicros: this.latency(),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      ...extra,
    };
  }
}

const round = (n) => Math.round(n * 10) / 10;

module.exports = { Metrics };
