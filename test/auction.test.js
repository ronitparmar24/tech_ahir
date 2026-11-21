'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuctionHouse, REASONS, OUTCOMES } = require('../src/auction');

/** Deterministic clock: time only moves when the test calls advance(). */
class FakeClock {
  constructor() {
    this.t = 1_000_000;
    this.timers = new Map();
    this.nextId = 1;
  }
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id) {
    this.timers.delete(id);
  }
  advance(ms) {
    const target = this.t + ms;
    for (;;) {
      let next = null;
      for (const [id, tm] of this.timers) if (tm.at <= target && (!next || tm.at < next.tm.at)) next = { id, tm };
      if (!next) break;
      this.timers.delete(next.id);
      this.t = next.tm.at;
      next.tm.fn();
    }
    this.t = target;
  }
}

function setup({ durationMs = 120_000, startingPrice = 100, minIncrement = 10, reservePrice = null, startsAt } = {}) {
  const clock = new FakeClock();
  const events = [];
  const house = new AuctionHouse({ clock, onEvent: (type, a, extra) => events.push({ type, a, extra }) });
  house.create({ id: 'a1', title: 'Test lot', startingPrice, minIncrement, reservePrice, durationMs, startsAt });
  return { clock, house, events };
}

const bid = (house, bidder, amount, maxAmount) => house.placeBid('a1', { bidder, amount, maxAmount });

// ------------------------------------------------------------------ basic rules

test('first bid must meet the starting price; later bids must beat price + increment', () => {
  const { house } = setup();
  assert.equal(bid(house, 'ann', 99).reason, REASONS.BID_TOO_LOW);
  assert.equal(bid(house, 'ann', 100).accepted, true);
  const low = bid(house, 'bob', 105);
  assert.equal(low.reason, REASONS.BID_TOO_LOW);
  assert.equal(low.minAcceptable, 110);
  assert.equal(bid(house, 'bob', 100).accepted, false, 'an equal bid is rejected');
  assert.equal(bid(house, 'bob', 110).outcome, OUTCOMES.LEADING);
  assert.equal(house.get('a1').currentPrice, 110);
  assert.equal(house.get('a1').leader, 'bob');
});

test('rejects invalid bidders and amounts (non-integers, strings, negatives)', () => {
  const { house } = setup();
  for (const amount of [0, -5, 150.5, '150', NaN, Infinity, null, undefined]) {
    assert.equal(bid(house, 'ann', amount).reason, REASONS.INVALID_AMOUNT, `amount ${amount}`);
  }
  for (const bidder of ['', '   ', null, 42, 'x'.repeat(41), '1233', '42 99']) {
    assert.equal(house.placeBid('a1', { bidder, amount: 200 }).reason, REASONS.INVALID_BIDDER);
  }
  assert.equal(bid(house, 'ann', 200, 150).reason, REASONS.MAX_BELOW_AMOUNT);
  assert.equal(house.placeBid('nope', { bidder: 'ann', amount: 200 }).reason, REASONS.NOT_FOUND);
  assert.equal(house.get('a1').bidCount, 0);
});

test('create validates its input', () => {
  const house = new AuctionHouse({ clock: new FakeClock() });
  assert.throws(() => house.create({ id: 'x', title: 'ok title', startingPrice: 0 }), /startingPrice/);
  assert.throws(() => house.create({ id: 'x', title: 'no' }), /title/);
  assert.throws(() => house.create({ id: 'bad id!', title: 'ok title' }), /id/);
  assert.throws(() => house.create({ id: 'x', title: 'ok title', startingPrice: 100, reservePrice: 50 }), /reservePrice/);
  assert.throws(() => house.create({ id: 'x', title: 'ok title', category: 'boats' }), /category/);
  house.create({ id: 'x', title: 'ok title' });
  assert.throws(() => house.create({ id: 'x', title: 'ok title' }), /exists/);
});

// ------------------------------------------------------------------ auto-bidding

test('auto-bid: leader with a higher max answers a challenger instantly, one increment above', () => {
  const { house } = setup();
  assert.equal(bid(house, 'ann', 100, 500).outcome, OUTCOMES.LEADING);
  assert.equal(house.get('a1').currentPrice, 100, 'price stays low: the max is hidden');

  const r = bid(house, 'bob', 200);
  assert.equal(r.accepted, true);
  assert.equal(r.outcome, OUTCOMES.OUTBID);
  assert.equal(r.leading, false);
  assert.deepEqual(r.entries.map((e) => [e.bidder, e.amount, e.auto]), [['bob', 200, false], ['ann', 210, true]]);
  assert.equal(house.get('a1').leader, 'ann');
  assert.equal(house.get('a1').currentPrice, 210);
});

test('auto-bid: a challenger above the max wins at one increment over it', () => {
  const { house } = setup();
  bid(house, 'ann', 100, 500);
  const r = bid(house, 'bob', 120, 1000);
  assert.equal(r.outcome, OUTCOMES.LEADING);
  // Ann's proxy is pushed to its max (500), Bob takes the lead at 510.
  assert.deepEqual(r.entries.map((e) => [e.bidder, e.amount]), [['ann', 500], ['bob', 510]]);
  assert.equal(house.get('a1').currentPrice, 510);
  assert.equal(house.get('a1').leader, 'bob');
});

test('auto-bid: a tie keeps the earlier bidder in front', () => {
  const { house } = setup();
  bid(house, 'ann', 100, 500);
  const r = bid(house, 'bob', 500);
  assert.equal(r.outcome, OUTCOMES.OUTBID);
  assert.equal(house.get('a1').leader, 'ann');
  assert.equal(house.get('a1').currentPrice, 500);
  assert.equal(r.entries[1].tie, true);
});

test('auto-bid: the leader can raise their max but not bid against themself', () => {
  const { house } = setup();
  bid(house, 'ann', 100, 300);
  assert.equal(bid(house, 'ann', 200).reason, REASONS.ALREADY_LEADING);
  assert.equal(bid(house, 'ann', 100, 250).reason, REASONS.ALREADY_LEADING, 'lowering is not allowed');
  const r = bid(house, 'ann', 100, 900);
  assert.equal(r.outcome, OUTCOMES.MAX_RAISED);
  assert.equal(r.entries.length, 0);
  assert.equal(house.get('a1').currentPrice, 100, 'raising your own max never raises the price');
  assert.equal(bid(house, 'bob', 800).outcome, OUTCOMES.OUTBID);
  assert.equal(house.get('a1').currentPrice, 810);
});

test('the hidden max never appears in public data', () => {
  const { house } = setup();
  bid(house, 'ann', 100, 777_777);
  assert.ok(!JSON.stringify(house.get('a1')).includes('777777'));
  assert.ok(!JSON.stringify(house.history('a1')).includes('777777'));
  assert.ok(!JSON.stringify(house.activity('ann')).includes('777777'));
});

// ------------------------------------------------------------------ reserve

test('reserve: no sale below it; a max that covers it jumps the price to it', () => {
  const { house, clock } = setup({ reservePrice: 1000 });
  bid(house, 'ann', 100);
  assert.equal(house.get('a1').reserveMet, false);
  const r = bid(house, 'bob', 110, 1500);
  assert.equal(r.outcome, OUTCOMES.LEADING);
  assert.equal(house.get('a1').currentPrice, 1000);
  assert.equal(house.get('a1').reserveMet, true);
  clock.advance(10 * 60_000);
  assert.deepEqual(house.get('a1').winner, { bidder: 'bob', amount: 1000 });
});

test('reserve not met: auction closes without a winner', () => {
  const { house, clock } = setup({ reservePrice: 1000 });
  bid(house, 'ann', 500);
  clock.advance(10 * 60_000);
  const a = house.get('a1');
  assert.equal(a.status, 'closed');
  assert.equal(a.outcome, 'RESERVE_NOT_MET');
  assert.equal(a.winner, null);
});

// ------------------------------------------------------------------ timing

test('a bid with more than 30s left does not extend the auction', () => {
  const { house, clock } = setup();
  const endsAt = house.get('a1').endsAt;
  clock.advance(60_000);
  assert.equal(bid(house, 'ann', 100).extended, false);
  assert.equal(house.get('a1').endsAt, endsAt);
});

test('a bid in the last 30s extends the auction by 30s and the late bidder can win', () => {
  const { house, clock, events } = setup();
  const originalEnd = house.get('a1').endsAt;
  bid(house, 'ann', 100);

  clock.advance(110_000); // 10s left
  const late = bid(house, 'bob', 150);
  assert.equal(late.extended, true);
  assert.equal(house.get('a1').endsAt, originalEnd + 30_000);

  clock.advance(15_000); // past the ORIGINAL end, inside the extension
  assert.equal(house.get('a1').status, 'open');

  clock.advance(25_000); // reaches the new end
  const a = house.get('a1');
  assert.equal(a.status, 'closed');
  assert.deepEqual(a.winner, { bidder: 'bob', amount: 150 });
  assert.equal(events.filter((e) => e.type === 'closed').length, 1);
});

test('a bid exactly 30s before the end counts as "in the last 30 seconds"', () => {
  const { house, clock } = setup();
  clock.advance(90_000);
  assert.equal(bid(house, 'ann', 100).extended, true);
});

test('raising your own max late does not extend (the price did not move)', () => {
  const { house, clock } = setup();
  bid(house, 'ann', 100, 200);
  clock.advance(110_000);
  const r = bid(house, 'ann', 100, 900);
  assert.equal(r.outcome, OUTCOMES.MAX_RAISED);
  assert.equal(r.extended, false);
});

test('repeated late bids keep extending; auction closes once with exactly one winner', () => {
  const { house, clock, events } = setup({ durationMs: 40_000 });
  let amount = 100;
  for (let i = 0; i < 10; i++) {
    clock.advance(house.get('a1').endsAt - clock.now() - 10_000); // 10s left
    const r = bid(house, `u${i}`, amount);
    assert.equal(r.extended, true);
    amount += 10;
  }
  clock.advance(10 * 60_000);
  const a = house.get('a1');
  assert.equal(a.status, 'closed');
  assert.equal(a.winner.bidder, 'u9');
  assert.equal(a.extensions, 10);
  assert.equal(events.filter((e) => e.type === 'closed').length, 1);
});

test('bids at or after the deadline are rejected, even if the close timer has not fired yet', () => {
  const clock = new FakeClock();
  const lazyClock = { now: () => clock.now(), setTimeout: () => 0, clearTimeout: () => {} }; // timers never fire
  const house = new AuctionHouse({ clock: lazyClock });
  house.create({ id: 'a1', title: 'Lazy timer', startingPrice: 100, minIncrement: 10, durationMs: 60_000 });
  house.placeBid('a1', { bidder: 'ann', amount: 100 });

  clock.t += 60_000; // exactly at endsAt
  assert.equal(house.placeBid('a1', { bidder: 'bob', amount: 500 }).reason, REASONS.AUCTION_CLOSED);
  const a = house.get('a1');
  assert.equal(a.status, 'closed');
  assert.equal(a.winner.bidder, 'ann');
});

test('scheduled auctions reject bids until they open, then open on time', () => {
  const clock = new FakeClock();
  const events = [];
  const house = new AuctionHouse({ clock, onEvent: (t) => events.push(t) });
  house.create({ id: 'a1', title: 'Later', startingPrice: 100, minIncrement: 10, durationMs: 60_000, startsAt: clock.now() + 30_000 });
  assert.equal(house.get('a1').status, 'scheduled');
  assert.equal(house.placeBid('a1', { bidder: 'ann', amount: 100 }).reason, REASONS.NOT_STARTED);
  clock.advance(30_000);
  assert.equal(house.get('a1').status, 'open');
  assert.ok(events.includes('opened'));
  assert.equal(house.placeBid('a1', { bidder: 'ann', amount: 100 }).accepted, true);
});

test('auction with no bids closes with no winner', () => {
  const { house, clock } = setup();
  clock.advance(120_000);
  const a = house.get('a1');
  assert.equal(a.status, 'closed');
  assert.equal(a.outcome, 'NO_BIDS');
  assert.equal(a.winner, null);
});

// ------------------------------------------------------------------ idempotency, history, activity

test('retrying the same bidId is idempotent (not counted twice)', () => {
  const { house } = setup();
  const first = house.placeBid('a1', { bidId: 'x1', bidder: 'ann', amount: 100 });
  const retry = house.placeBid('a1', { bidId: 'x1', bidder: 'ann', amount: 100 });
  assert.equal(first.accepted, true);
  assert.equal(retry.duplicate, true);
  assert.equal(house.get('a1').bidCount, 1);
});

test('activity reports leading / outbid / won / lost per bidder', () => {
  const { house, clock } = setup();
  bid(house, 'ann', 100);
  bid(house, 'bob', 110);
  assert.equal(house.activity('ann')[0].state, 'outbid');
  assert.equal(house.activity('bob')[0].state, 'leading');
  clock.advance(10 * 60_000);
  assert.equal(house.activity('ann')[0].state, 'lost');
  assert.equal(house.activity('bob')[0].state, 'won');
  assert.deepEqual(house.activity('nobody'), []);
});

// ------------------------------------------------------------------ invariants under load

test('1,000 interleaved bids (some with auto-bid maxima): every invariant holds', () => {
  const { house, clock } = setup();
  const amounts = Array.from({ length: 1000 }, (_, i) => 100 + i * 10).sort(() => Math.random() - 0.5);
  for (const [i, amount] of amounts.entries()) {
    const withMax = i % 7 === 0;
    house.placeBid('a1', { bidId: `b${i}`, bidder: `user${i % 60}`, amount, maxAmount: withMax ? amount + 50 : null });
  }
  const report = house.verify('a1');
  assert.ok(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok)));
  clock.advance(10 * 60_000);
  const closed = house.verify('a1');
  assert.ok(closed.ok, JSON.stringify(closed.checks.filter((c) => !c.ok)));
  assert.equal(house.get('a1').winner.bidder, house.get('a1').leader);
});

// ------------------------------------------------------------------ event sourcing

test('restore() replays the command log into an identical state', () => {
  const clock = new FakeClock();
  const log = [];
  const live = new AuctionHouse({ clock, log: { append: (e) => log.push(JSON.parse(JSON.stringify(e))) } });
  live.create({ id: 'a1', title: 'Replay me', startingPrice: 100, minIncrement: 10, reservePrice: 400, durationMs: 120_000 });
  live.create({ id: 'a2', title: 'Second lot', startingPrice: 50, minIncrement: 5, durationMs: 300_000 });
  live.placeBid('a1', { bidId: 'p1', bidder: 'ann', amount: 100, maxAmount: 300 });
  clock.advance(5_000);
  live.placeBid('a1', { bidId: 'p2', bidder: 'bob', amount: 150 });
  live.placeBid('a1', { bidId: 'p3', bidder: 'cat', amount: 320, maxAmount: 600 });
  clock.advance(100_000); // a1 now in its final 15s
  live.placeBid('a1', { bidId: 'p4', bidder: 'dan', amount: 650 });
  live.placeBid('a2', { bidder: 'eve', amount: 50 });
  live.placeBid('a1', { bidder: 'zed', amount: 1 }); // rejected: never logged

  assert.equal(log.filter((e) => e.type === 'bid').length, 5, 'only accepted commands are logged');

  const restored = new AuctionHouse({ clock });
  const res = restored.restore(log);
  assert.equal(res.mismatches, 0);
  for (const id of ['a1', 'a2']) {
    assert.deepEqual(restored.get(id), live.get(id), `snapshot of ${id}`);
    assert.deepEqual(restored.history(id, 1000), live.history(id, 1000), `history of ${id}`);
  }
  // Idempotency survives a restart too.
  assert.equal(restored.placeBid('a1', { bidId: 'p4', bidder: 'dan', amount: 650 }).duplicate, true);
  // Timers are re-armed: both auctions close on schedule after the restart.
  clock.advance(10 * 60_000);
  assert.equal(restored.get('a1').status, 'closed');
  assert.equal(restored.get('a1').winner.bidder, 'dan');
  assert.equal(restored.get('a2').winner.bidder, 'eve');
});
