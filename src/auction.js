'use strict';

/**
 * Auction engine: bidding rules + state. No HTTP, no sockets, no disk.
 *
 * CONCURRENCY: every command (create, placeBid) runs synchronously from start
 * to finish. Node executes one JavaScript call at a time, so "read price ->
 * validate -> write price" can never interleave with another bid. Each auction
 * has exactly one writer — the same single-writer model the design note scales
 * out with one owner per auction shard.
 *
 * FEATURES
 *  - Minimum increment, starting price, optional hidden reserve price.
 *  - Auto-bidding (proxy bids): a bidder may give a `maxAmount`; the engine bids
 *    for them only as much as needed to stay ahead, up to that ceiling.
 *  - Anti-sniping: any bid that moves the price with <= 30s left adds 30s.
 *  - Scheduled start, exactly-once close, one winner (or none if reserve not met).
 *  - Event sourcing: accepted commands go to an append-only log; `restore()`
 *    replays them deterministically to rebuild state after a restart.
 *
 * Money is integer only (whole rupees / cents) to avoid floating-point errors.
 */

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t),
};

const REASONS = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  NOT_STARTED: 'NOT_STARTED',
  AUCTION_CLOSED: 'AUCTION_CLOSED',
  INVALID_BIDDER: 'INVALID_BIDDER',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  MAX_BELOW_AMOUNT: 'MAX_BELOW_AMOUNT',
  BID_TOO_LOW: 'BID_TOO_LOW',
  ALREADY_LEADING: 'ALREADY_LEADING',
});

const OUTCOMES = Object.freeze({
  LEADING: 'LEADING', // you are now the highest bidder
  OUTBID: 'OUTBID', // bid placed, but the leader's auto-bid answered higher
  MAX_RAISED: 'MAX_RAISED', // leader raised their own auto-bid ceiling
});

const CATEGORIES = Object.freeze(['watches', 'cameras', 'art', 'sneakers', 'collectibles', 'music', 'tech']);

const MAX_AMOUNT = 1e12;
const MIN_DURATION_MS = 5_000;
const MAX_DURATION_MS = 30 * 24 * 3600_000;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout overflows past ~24.8 days

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const isPositiveInt = (n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_AMOUNT;
/** A display name: 1–40 chars and at least one letter, so "1233" is not a name. */
const isValidName = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 40 && /\p{L}/u.test(s);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

class AuctionHouse {
  #replaying = false;
  #replayAt = null;

  /**
   * @param {object} [opts]
   * @param {object} [opts.clock] {now, setTimeout, clearTimeout}; tests inject a fake one
   * @param {number} [opts.extendWindowMs] a price-moving bid with this much time or less left extends the auction
   * @param {number} [opts.extendByMs] how much a late bid extends the auction by
   * @param {{append(event: object): void}} [opts.log] durable append-only command log
   * @param {(type: string, auction: object, extra?: object) => void} [opts.onEvent]
   *        'created' | 'opened' | 'bid' | 'closed', called after each state change
   */
  constructor({ clock = realClock, extendWindowMs = 30_000, extendByMs = 30_000, log = null, onEvent = () => {} } = {}) {
    this.clock = clock;
    this.extendWindowMs = extendWindowMs;
    this.extendByMs = extendByMs;
    this.log = log;
    this.onEvent = onEvent;
    this.auctions = new Map();
  }

  // ---------------------------------------------------------------- commands

  create(input = {}) {
    const now = this.#now();
    const spec = normalizeSpec(input, now);
    if (this.auctions.has(spec.id)) throw new ValidationError(`auction "${spec.id}" already exists`);

    const a = {
      ...spec,
      status: spec.startsAt <= now ? 'open' : 'scheduled',
      createdAt: now,
      endsAt: spec.startsAt + spec.durationMs,
      closedAt: null,
      currentPrice: null,
      leader: null,
      leaderMax: null, // hidden: the leader's auto-bid ceiling. Never leaves the engine.
      outcome: null,
      winner: null,
      extensions: 0,
      bids: [], // bid history entries, in order. Strictly rising, except tie entries.
      bidders: new Set(),
      results: new Map(), // bidId -> result: a retried request is never counted twice
      timer: null,
    };
    this.auctions.set(a.id, a);
    this.#append({ type: 'create', at: now, input: spec });
    this.#arm(a);
    this.#emit('created', a);
    return toPublic(a);
  }

  /**
   * Accept or reject one bid. Synchronous on purpose (see file header).
   * @param {string} id
   * @param {{bidId?: string, bidder: string, amount: number, maxAmount?: number|null}} cmd
   */
  placeBid(id, cmd = {}) {
    const a = this.auctions.get(id);
    if (!a) return { accepted: false, reason: REASONS.NOT_FOUND };

    const bidId = cmd.bidId == null || cmd.bidId === '' ? null : String(cmd.bidId).slice(0, 100);
    if (bidId !== null && a.results.has(bidId)) {
      return { ...a.results.get(bidId), duplicate: true, auction: toPublic(a) };
    }

    const result = this.#evaluate(a, this.#now(), { ...cmd, bidId });
    if (bidId !== null && result.accepted) a.results.set(bidId, result);
    return result;
  }

  /**
   * Rebuild state from a command log (event sourcing). Replays every command
   * at its original timestamp, so the result is identical to the live run.
   */
  restore(events) {
    let replayed = 0;
    let mismatches = 0;
    this.#replaying = true;
    try {
      for (const ev of events) {
        this.#replayAt = ev.at;
        if (ev.type === 'create') {
          this.create(ev.input);
          replayed++;
        } else if (ev.type === 'bid') {
          const r = this.placeBid(ev.auctionId, ev.cmd);
          if (r.accepted) replayed++;
          else mismatches++;
        }
      }
    } finally {
      this.#replaying = false;
      this.#replayAt = null;
    }
    // Catch up with real time: close anything that ended while we were down, arm timers.
    for (const a of this.auctions.values()) {
      this.#refresh(a, this.#now());
      this.#arm(a);
    }
    return { replayed, mismatches };
  }

  // ------------------------------------------------------------------- reads

  get(id) {
    const a = this.auctions.get(id);
    if (!a) return null;
    this.#refresh(a, this.#now());
    return toPublic(a);
  }

  list() {
    const now = this.#now();
    return [...this.auctions.values()].map((a) => {
      this.#refresh(a, now);
      return toPublic(a);
    });
  }

  history(id, limit = 50) {
    const a = this.auctions.get(id);
    if (!a) return null;
    return a.bids.slice(-limit).map((b) => ({ ...b }));
  }

  /** Everything one bidder has taken part in. Hidden maxima are never exposed. */
  activity(bidder) {
    const name = text(bidder, 40);
    const now = this.#now();
    const items = [];
    for (const a of this.auctions.values()) {
      if (!a.bidders.has(name)) continue;
      this.#refresh(a, now);
      let yourHighest = 0;
      let yourBids = 0;
      for (const b of a.bids) {
        if (b.bidder === name) {
          yourBids++;
          yourHighest = Math.max(yourHighest, b.amount);
        }
      }
      const state =
        a.status === 'closed'
          ? a.winner && a.winner.bidder === name ? 'won' : 'lost'
          : a.leader === name ? 'leading' : 'outbid';
      items.push({ auction: toPublic(a), yourHighest, yourBids, state });
    }
    return items;
  }

  /** Re-check the invariants of one auction from its full bid history. */
  verify(id) {
    const a = this.auctions.get(id);
    if (!a) return null;
    this.#refresh(a, this.#now());
    const checks = [];
    const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
    const bids = a.bids;

    check('Sequence numbers are contiguous', bids.every((b, i) => b.seq === i + 1), `${bids.length} entries`);

    let rising = true;
    for (let i = 1; i < bids.length; i++) {
      const prev = bids[i - 1].amount;
      const cur = bids[i].amount;
      if (bids[i].tie ? cur !== prev : cur <= prev) rising = false;
    }
    check('Price only ever goes up', rising);

    const last = bids[bids.length - 1];
    check('Current price equals the last entry', last ? a.currentPrice === last.amount : a.currentPrice === null,
      last ? `price ${a.currentPrice}` : 'no bids');
    check('Leader is the last bidder', last ? a.leader === last.bidder : a.leader === null, a.leader || 'none');
    check('First bid meets the starting price', !bids[0] || bids[0].amount >= a.startingPrice);
    check('No bid before start or after close', bids.every((b) => b.at >= a.startsAt && b.at < a.endsAt));

    if (a.status === 'closed') {
      const expectWinner = a.leader && (a.reservePrice == null || a.currentPrice >= a.reservePrice);
      check('Closed exactly at the deadline', a.closedAt === a.endsAt);
      check(
        'Exactly one winner (or none if reserve not met)',
        expectWinner ? a.winner && a.winner.bidder === a.leader && a.winner.amount === a.currentPrice : a.winner === null,
        a.winner ? `${a.winner.bidder} @ ${a.winner.amount}` : a.outcome,
      );
    }
    return { ok: checks.every((c) => c.ok), checks, auction: toPublic(a) };
  }

  stats() {
    const now = this.#now();
    const out = { total: 0, open: 0, scheduled: 0, closed: 0, bids: 0 };
    for (const a of this.auctions.values()) {
      this.#refresh(a, now);
      out.total++;
      out[a.status]++;
      out.bids += a.bids.length;
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  #evaluate(a, now, cmd) {
    // The server clock is the only authority on time. If a deadline has passed
    // but its timer has not fired yet, apply it now.
    this.#refresh(a, now);
    if (a.status === 'scheduled') return reject(a, REASONS.NOT_STARTED);
    if (a.status === 'closed') return reject(a, REASONS.AUCTION_CLOSED);

    const bidder = typeof cmd.bidder === 'string' ? cmd.bidder.trim() : '';
    if (!isValidName(bidder)) return reject(a, REASONS.INVALID_BIDDER);
    const amount = cmd.amount;
    if (!isPositiveInt(amount)) return reject(a, REASONS.INVALID_AMOUNT);
    const hasMax = cmd.maxAmount !== undefined && cmd.maxAmount !== null;
    if (hasMax && !isPositiveInt(cmd.maxAmount)) return reject(a, REASONS.INVALID_AMOUNT);
    if (hasMax && cmd.maxAmount < amount) return reject(a, REASONS.MAX_BELOW_AMOUNT);
    const ceiling = hasMax ? cmd.maxAmount : amount;

    const prevPrice = a.currentPrice;
    const entries = [];
    let outcome;

    if (a.leader === bidder) {
      // The leader can't bid against themself; they can only raise their auto-bid ceiling.
      if (ceiling <= a.leaderMax) return reject(a, REASONS.ALREADY_LEADING);
      a.leaderMax = ceiling;
      outcome = OUTCOMES.MAX_RAISED;
    } else {
      const minAcceptable = minimumBid(a);
      if (amount < minAcceptable) return { ...reject(a, REASONS.BID_TOO_LOW), minAcceptable };

      if (a.leader === null) {
        a.currentPrice = amount;
        a.leader = bidder;
        a.leaderMax = ceiling;
        entries.push({ bidder, amount, auto: false });
        outcome = OUTCOMES.LEADING;
      } else if (ceiling > a.leaderMax) {
        // Challenger beats the leader's ceiling. The old leader's proxy fights up to its max first.
        if (a.leaderMax > a.currentPrice) entries.push({ bidder: a.leader, amount: a.leaderMax, auto: true });
        const price = Math.max(amount, Math.min(ceiling, a.leaderMax + a.minIncrement));
        entries.push({ bidder, amount: price, auto: price > amount });
        a.currentPrice = price;
        a.leader = bidder;
        a.leaderMax = ceiling;
        outcome = OUTCOMES.LEADING;
      } else {
        // Leader's auto-bid is at least as high: it answers immediately.
        // On a tie, the earlier bidder keeps the lead.
        entries.push({ bidder, amount: ceiling, auto: ceiling > amount });
        const answer = Math.min(a.leaderMax, ceiling + a.minIncrement);
        entries.push({ bidder: a.leader, amount: answer, auto: true, tie: answer === ceiling });
        a.currentPrice = answer;
        outcome = OUTCOMES.OUTBID;
      }
    }

    // Reserve: if the leader's ceiling covers the reserve, the price jumps to it.
    if (a.reservePrice != null && a.currentPrice < a.reservePrice && a.leaderMax >= a.reservePrice) {
      const last = entries[entries.length - 1];
      if (last && last.bidder === a.leader) {
        last.amount = a.reservePrice;
        last.auto = true;
        last.tie = false;
      } else {
        entries.push({ bidder: a.leader, amount: a.reservePrice, auto: true });
      }
      a.currentPrice = a.reservePrice;
    }

    // Anti-sniping: a price-moving bid in the final window extends the auction.
    let extended = false;
    if (a.currentPrice !== prevPrice && a.endsAt - now <= this.extendWindowMs) {
      a.endsAt += this.extendByMs;
      a.extensions++;
      extended = true;
    }

    const recorded = entries.map((e) => {
      const entry = { seq: a.bids.length + 1, bidder: e.bidder, amount: e.amount, auto: e.auto, at: now };
      if (e.tie) entry.tie = true;
      a.bids.push(entry);
      a.bidders.add(e.bidder);
      return entry;
    });
    a.bidders.add(bidder);

    // Write-ahead: the command is durable before anyone is told it happened.
    this.#append({
      type: 'bid',
      at: now,
      auctionId: a.id,
      cmd: { bidId: cmd.bidId, bidder, amount, maxAmount: hasMax ? cmd.maxAmount : null },
    });
    if (extended) this.#arm(a);
    this.#emit('bid', a, { entries: recorded, extended });

    return {
      accepted: true,
      outcome,
      leading: a.leader === bidder,
      entries: recorded.map((e) => ({ ...e })),
      extended,
      auction: toPublic(a),
    };
  }

  /** Apply time-based transitions. Idempotent. */
  #refresh(a, now) {
    if (a.status === 'scheduled' && now >= a.startsAt) {
      a.status = 'open';
      this.#emit('opened', a);
    }
    if (a.status === 'open' && now >= a.endsAt) this.#close(a);
  }

  #close(a) {
    if (a.status === 'closed') return; // one-way, exactly once
    if (a.timer) this.clock.clearTimeout(a.timer);
    a.timer = null;
    a.status = 'closed';
    a.closedAt = a.endsAt;
    if (!a.leader) {
      a.outcome = 'NO_BIDS';
    } else if (a.reservePrice != null && a.currentPrice < a.reservePrice) {
      a.outcome = 'RESERVE_NOT_MET';
    } else {
      a.outcome = 'SOLD';
      a.winner = { bidder: a.leader, amount: a.currentPrice };
    }
    this.#emit('closed', a);
  }

  /** One timer per auction, pointing at its next transition. Re-armed whenever endsAt moves. */
  #arm(a) {
    if (this.#replaying) return;
    if (a.timer) this.clock.clearTimeout(a.timer);
    a.timer = null;
    if (a.status === 'closed') return;
    const target = a.status === 'scheduled' ? a.startsAt : a.endsAt;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, target - this.clock.now()));
    a.timer = this.clock.setTimeout(() => {
      a.timer = null;
      this.#refresh(a, this.#now());
      this.#arm(a);
    }, delay);
  }

  #now() {
    return this.#replayAt ?? this.clock.now();
  }

  #append(event) {
    if (!this.#replaying && this.log) this.log.append(event);
  }

  #emit(type, a, extra) {
    if (!this.#replaying) this.onEvent(type, toPublic(a), extra);
  }
}

function normalizeSpec(input, now) {
  const id = text(input.id, 64);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) throw new ValidationError('id must be letters, digits and dashes');
  const title = text(input.title, 80);
  if (title.length < 3) throw new ValidationError('title must be at least 3 characters');

  const category = input.category ?? 'collectibles';
  if (!CATEGORIES.includes(category)) throw new ValidationError(`category must be one of ${CATEGORIES.join(', ')}`);

  const startingPrice = input.startingPrice ?? 1;
  const minIncrement = input.minIncrement ?? 1;
  if (!isPositiveInt(startingPrice)) throw new ValidationError('startingPrice must be a positive integer');
  if (!isPositiveInt(minIncrement)) throw new ValidationError('minIncrement must be a positive integer');

  const reservePrice = input.reservePrice ?? null;
  if (reservePrice !== null && (!isPositiveInt(reservePrice) || reservePrice < startingPrice)) {
    throw new ValidationError('reservePrice must be an integer >= startingPrice');
  }

  const durationMs = input.durationMs ?? 60_000;
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    throw new ValidationError('duration must be between 5 seconds and 30 days');
  }

  const startsAt = input.startsAt ?? now;
  if (!Number.isSafeInteger(startsAt)) throw new ValidationError('startsAt must be a timestamp');

  const palette = Number.isSafeInteger(input.palette) ? Math.abs(input.palette) % 8 : 0;

  return {
    id,
    title,
    description: text(input.description, 1000),
    category,
    seller: isValidName(text(input.seller, 40)) ? text(input.seller, 40) : 'Anonymous',
    palette,
    startingPrice,
    minIncrement,
    reservePrice,
    durationMs,
    startsAt,
  };
}

function minimumBid(a) {
  return a.currentPrice === null ? a.startingPrice : a.currentPrice + a.minIncrement;
}

function reject(a, reason) {
  return { accepted: false, reason, auction: toPublic(a) };
}

function toPublic(a) {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    category: a.category,
    seller: a.seller,
    palette: a.palette,
    status: a.status,
    startingPrice: a.startingPrice,
    minIncrement: a.minIncrement,
    hasReserve: a.reservePrice != null,
    reserveMet: a.reservePrice == null ? null : (a.currentPrice ?? 0) >= a.reservePrice,
    currentPrice: a.currentPrice,
    minNextBid: a.status === 'closed' ? null : minimumBid(a),
    leader: a.leader,
    bidCount: a.bids.length,
    bidderCount: a.bidders.size,
    createdAt: a.createdAt,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    closedAt: a.closedAt,
    extensions: a.extensions,
    outcome: a.outcome,
    winner: a.winner ? { ...a.winner } : null,
  };
}

module.exports = { AuctionHouse, REASONS, OUTCOMES, CATEGORIES, ValidationError };
