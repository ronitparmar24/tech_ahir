'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { createClient } = require('../src/http-client');

async function start(opts) {
  const ctx = createServer(opts);
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  const client = createClient();
  return {
    ...ctx,
    post: (p, body) => client.post(base + p, body),
    get: (p) => client.get(base + p).then((r) => r.body),
    stop: async () => {
      client.close();
      await ctx.close();
    },
  };
}

test('500 simultaneous HTTP bids: state stays consistent and the highest bid wins', async () => {
  const s = await start();
  try {
    const created = await s.post('/api/auctions', { id: 'race', title: 'Race lot', startingPrice: 100, minIncrement: 1, durationSeconds: 300 });
    assert.equal(created.status, 201);

    const amounts = Array.from({ length: 500 }, (_, i) => 100 + i).sort(() => Math.random() - 0.5);
    const results = await Promise.all(
      amounts.map((amount, i) => s.post('/api/auctions/race/bids', { bidId: `b${i}`, bidder: `user${i}`, amount })),
    );
    for (const r of results) assert.ok([201, 409].includes(r.status), `unexpected status ${r.status}`);

    const accepted = results.filter((r) => r.body.accepted);
    const { auction } = await s.get('/api/auctions/race');
    const max = Math.max(...amounts);
    assert.equal(auction.currentPrice, max, 'the highest bid always ends up on top');
    assert.equal(auction.leader, `user${amounts.indexOf(max)}`);
    assert.equal(auction.bidCount, accepted.length, 'every accepted response is recorded exactly once');

    const report = await s.get('/api/auctions/race/verify');
    assert.equal(report.ok, true, JSON.stringify(report.checks));
  } finally {
    await s.stop();
  }
});

test('stress endpoint runs a burst through HTTP and verifies invariants', async () => {
  const s = await start();
  try {
    await s.post('/api/auctions', { id: 'stress', title: 'Stress lot', startingPrice: 100, minIncrement: 5, durationSeconds: 300 });
    const r = await s.post('/api/auctions/stress/stress', { count: 300 });
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, 300);
    assert.equal(r.body.highestWon, true);
    assert.equal(r.body.verify.ok, true);
  } finally {
    await s.stop();
  }
});

test('HTTP status codes and validation', async () => {
  const s = await start();
  try {
    await s.post('/api/auctions', { id: 'codes', title: 'Codes lot', startingPrice: 100, minIncrement: 10, durationSeconds: 60 });
    assert.equal((await s.post('/api/auctions/codes/bids', { bidder: 'a', amount: 50 })).status, 409);
    assert.equal((await s.post('/api/auctions/codes/bids', { bidder: 'a', amount: 'abc' })).status, 400);
    assert.equal((await s.post('/api/auctions/missing/bids', { bidder: 'a', amount: 500 })).status, 404);
    assert.equal((await s.post('/api/auctions/codes/bids', { bidId: 'k1', bidder: 'a', amount: 100 })).status, 201);
    assert.equal((await s.post('/api/auctions/codes/bids', { bidId: 'k1', bidder: 'a', amount: 100 })).status, 200, 'idempotent retry');
    assert.equal((await s.post('/api/auctions/codes/bids', { bidder: 'a', amount: 100 })).status, 409, 'already leading at that amount');
    const raised = await s.post('/api/auctions/codes/bids', { bidder: 'a', amount: 100, maxAmount: 500 });
    assert.equal(raised.body.outcome, 'MAX_RAISED', 'leader may raise their own auto-bid max');
    assert.equal((await s.post('/api/auctions', { id: 'codes', title: 'Dup lot' })).status, 400, 'duplicate auction id');
    assert.equal((await s.post('/api/auctions', { title: 'x' })).status, 400, 'title too short');
  } finally {
    await s.stop();
  }
});

test('rate limiting: a single bidder flooding gets 429s', async () => {
  const s = await start({ rateLimit: { perSecond: 2, burst: 3 } });
  try {
    await s.post('/api/auctions', { id: 'rl', title: 'Rate lot', startingPrice: 100, minIncrement: 1, durationSeconds: 60 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => s.post('/api/auctions/rl/bids', { bidder: 'spammer', amount: 100 + i })));
    assert.ok(results.some((r) => r.status === 429));
    assert.ok(results.filter((r) => r.status !== 429).length <= 3);
  } finally {
    await s.stop();
  }
});

test('durability: state survives a server restart via the SQLite database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-'));
  const dbFile = path.join(dir, 'lotline.db');
  try {
    const s1 = await start({ dbFile });
    await s1.post('/api/auctions', { id: 'durable', title: 'Durable lot', startingPrice: 100, minIncrement: 10, durationSeconds: 300 });
    await s1.post('/api/auctions/durable/bids', { bidder: 'ann', amount: 100, maxAmount: 400 });
    await s1.post('/api/auctions/durable/bids', { bidder: 'bob', amount: 200 });
    const before = await s1.get('/api/auctions/durable');
    await s1.stop();

    const s2 = await start({ dbFile }); // "crash" and come back
    try {
      assert.equal(s2.restored.mismatches, 0);
      const after = await s2.get('/api/auctions/durable');
      assert.deepEqual(after.auction, before.auction);
      assert.deepEqual(after.history, before.history);
      // The hidden auto-bid max survived as well: Ann's proxy still defends.
      const r = await s2.post('/api/auctions/durable/bids', { bidder: 'cat', amount: 300 });
      assert.equal(r.body.outcome, 'OUTBID');
    } finally {
      await s2.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('database: auctions, bids, users and commands are stored in SQLite tables', async () => {
  const s = await start({ dbFile: ':memory:' });
  try {
    await s.post('/api/auctions', { id: 'stored', title: 'Stored lot', seller: 'shop', startingPrice: 100, minIncrement: 10, durationSeconds: 300 });
    await s.post('/api/auctions/stored/bids', { bidder: 'ann', amount: 100, maxAmount: 300 });
    await s.post('/api/auctions/stored/bids', { bidder: 'bob', amount: 150 }); // answered by Ann's auto-bid
    await s.post('/api/auctions/stored/bids', { bidder: 'zed', amount: 1 }); // rejected: not stored

    const db = s.db.db;
    const row = db.prepare('SELECT * FROM auctions WHERE id = ?').get('stored');
    assert.equal(row.current_price, 160);
    assert.equal(row.leader, 'ann');
    assert.equal(row.bid_count, 3);

    const bids = db.prepare('SELECT bidder, amount, auto FROM bids WHERE auction_id = ? ORDER BY seq').all('stored');
    assert.deepEqual(bids.map((b) => [b.bidder, b.amount, b.auto]), [['ann', 100, 0], ['bob', 150, 0], ['ann', 160, 1]]);

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type = 'bid'").get().n, 2, 'only accepted bids are logged');
    const users = db.prepare('SELECT name, bids, listings FROM users ORDER BY name').all().map((u) => [u.name, u.bids, u.listings]);
    assert.deepEqual(users, [['ann', 1, 0], ['bob', 1, 0], ['shop', 0, 1]]);

    // Duplicate (auction_id, seq) is impossible at the database level.
    assert.throws(() => db.prepare('INSERT INTO bids (auction_id, seq, bidder, amount, at) VALUES (?, 1, ?, 999, 0)').run('stored', 'x'), /UNIQUE|PRIMARY/i);

    const history = await s.get('/api/auctions/stored/history');
    assert.equal(history.source, 'sqlite');
    assert.equal(history.history.length, 3);
    const info = await s.get('/api/db');
    assert.equal(info.enabled, true);
    assert.equal(info.bids, 3);
  } finally {
    await s.stop();
  }
});

test('simulated bidders can be switched on and off at runtime', async () => {
  const s = await start();
  try {
    assert.deepEqual(await s.get('/api/demo/bots'), { enabled: false });
    assert.equal((await s.post('/api/demo/bots', { enabled: 'yes' })).status, 400);
    assert.equal((await s.post('/api/demo/bots', { enabled: true })).body.enabled, true);
    assert.equal(s.bots.enabled, true);
    assert.equal((await s.post('/api/demo/bots', { enabled: false })).body.enabled, false);
    assert.equal(s.bots.enabled, false);
  } finally {
    await s.stop();
  }
});

test('bidder names must contain letters', async () => {
  const s = await start();
  try {
    await s.post('/api/auctions', { id: 'names', title: 'Names lot', startingPrice: 100, minIncrement: 10, durationSeconds: 60 });
    const numeric = await s.post('/api/auctions/names/bids', { bidder: '1233', amount: 100 });
    assert.equal(numeric.status, 400);
    assert.equal(numeric.body.reason, 'INVALID_BIDDER');
    assert.equal((await s.post('/api/auctions/names/bids', { bidder: 'riya_1233', amount: 100 })).status, 201);
  } finally {
    await s.stop();
  }
});
