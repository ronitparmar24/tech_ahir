'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const { AuctionHouse, REASONS, CATEGORIES, ValidationError } = require('./auction');
const { Store } = require('./db');
const { Metrics } = require('./metrics');
const { RateLimiter } = require('./rate-limit');
const { Realtime } = require('./realtime');
const { createClient } = require('./http-client');
const { seedDemo, createBots, slug } = require('./demo');

const STATUS_BY_REASON = {
  [REASONS.NOT_FOUND]: 404,
  [REASONS.INVALID_BIDDER]: 400,
  [REASONS.INVALID_AMOUNT]: 400,
  [REASONS.MAX_BELOW_AMOUNT]: 400,
  [REASONS.BID_TOO_LOW]: 409,
  [REASONS.ALREADY_LEADING]: 409,
  [REASONS.NOT_STARTED]: 409,
  [REASONS.AUCTION_CLOSED]: 409,
  RATE_LIMITED: 429,
};

const toInt = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/**
 * Build the app without listening, so tests can start it on a random port.
 * @param {object} [opts]
 * @param {string|null} [opts.dbFile] SQLite database file (':memory:' allowed); null = no database
 * @param {object} [opts.engine] AuctionHouse options (clock, extension window)
 * @param {object} [opts.rateLimit] {perSecond, burst} per bidder
 */
function createServer({ dbFile = null, engine = {}, rateLimit = {}, bots: botsOn = false } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const metrics = new Metrics();
  const limiter = new RateLimiter(rateLimit);
  const db = dbFile ? new Store(dbFile) : null;

  let realtime = null;
  const house = new AuctionHouse({
    ...engine,
    log: db, // every accepted command is written to SQLite before it is acknowledged
    onEvent: (type, auction, extra) => {
      if (db) db.project(type, auction, extra); // keep the auctions/bids tables current
      if (realtime) realtime.onEvent(type, auction, extra);
    },
  });
  let restored = { replayed: 0, mismatches: 0 };
  if (db) {
    restored = house.restore(db.readAll()); // replay the command log
    db.rebuild(house); // and rewrite the read model from it
  }

  const getStats = () =>
    metrics.snapshot({
      auctions: house.stats(),
      sockets: io.engine.clientsCount,
      eventsPersisted: db ? db.count : null,
      db: db ? db.stats() : null,
      restored,
      serverTime: Date.now(),
    });
  realtime = new Realtime({ io, house, metrics, getStats });

  /** The single entry point for bids — HTTP, bots and stress tests all use it. */
  function placeBid(id, cmd) {
    const t0 = process.hrtime.bigint();
    const result = house.placeBid(id, cmd);
    metrics.recordBid(result, Number(process.hrtime.bigint() - t0) / 1000);
    return result;
  }

  const bots = createBots({ house, placeBid }, {
    enabled: botsOn,
    onChange: (enabled) => io.emit('demo:bots', { enabled }), // every open page updates its switch
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  const api = express.Router();

  api.get('/time', (req, res) => res.json({ serverTime: Date.now() }));
  api.get('/categories', (req, res) => res.json({ categories: CATEGORIES }));

  api.get('/auctions', (req, res) => {
    const now = Date.now();
    const { status = 'all', category, q, sort = 'ending', ids } = req.query;
    let list = house.list().map((a) => realtime.decorate(a));
    if (ids) {
      const wanted = new Set(String(ids).split(','));
      list = list.filter((a) => wanted.has(a.id));
    }
    const byStatus = { live: 'open', upcoming: 'scheduled', ended: 'closed' };
    if (byStatus[status]) list = list.filter((a) => a.status === byStatus[status]);
    if (status === 'ending') list = list.filter((a) => a.status === 'open' && a.endsAt - now < 10 * 60_000);
    if (category && category !== 'all') list = list.filter((a) => a.category === category);
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter((a) => `${a.title} ${a.description} ${a.seller}`.toLowerCase().includes(needle));
    }
    const rank = { open: 0, scheduled: 1, closed: 2 };
    const sorters = {
      ending: (a, b) => rank[a.status] - rank[b.status] || (a.status === 'closed' ? b.endsAt - a.endsAt : a.endsAt - b.endsAt),
      bids: (a, b) => b.bidCount - a.bidCount,
      price: (a, b) => (b.currentPrice ?? b.startingPrice) - (a.currentPrice ?? a.startingPrice),
      newest: (a, b) => b.createdAt - a.createdAt,
    };
    list.sort(sorters[sort] || sorters.ending);
    res.json({ auctions: list, summary: realtime.summary(), serverTime: now });
  });

  api.post('/auctions', (req, res) => {
    const b = req.body || {};
    try {
      const startsIn = toInt(b.startsInSeconds) ?? 0;
      const auction = house.create({
        id: b.id ? String(b.id) : slug(String(b.title || 'lot')),
        title: b.title,
        description: b.description,
        category: b.category,
        seller: b.seller,
        palette: toInt(b.palette),
        startingPrice: toInt(b.startingPrice) ?? 100,
        minIncrement: toInt(b.minIncrement) ?? 10,
        reservePrice: toInt(b.reservePrice) ?? null,
        startsAt: startsIn > 0 ? Date.now() + Math.round(startsIn * 1000) : undefined,
        durationMs: Math.round((toInt(b.durationSeconds) ?? 60) * 1000),
      });
      res.status(201).json({ auction: realtime.decorate(auction), serverTime: Date.now() });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  api.get('/auctions/:id', (req, res) => {
    const auction = house.get(req.params.id);
    if (!auction) return res.status(404).json({ reason: REASONS.NOT_FOUND });
    res.json({ auction: realtime.decorate(auction), history: house.history(req.params.id, 50), serverTime: Date.now() });
  });

  // Full history comes straight from the database (SQL, indexed by auction + seq).
  api.get('/auctions/:id/history', (req, res) => {
    if (!house.get(req.params.id)) return res.status(404).json({ reason: REASONS.NOT_FOUND });
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    res.json({ history: db ? db.history(req.params.id, limit) : house.history(req.params.id, limit), source: db ? 'sqlite' : 'memory' });
  });

  api.post('/auctions/:id/bids', (req, res) => {
    const { bidId, bidder, amount, maxAmount } = req.body || {};
    if (typeof bidder === 'string' && !limiter.take(bidder.trim().toLowerCase())) {
      return res.status(429).json({ accepted: false, reason: 'RATE_LIMITED', serverTime: Date.now() });
    }
    const result = placeBid(req.params.id, { bidId, bidder, amount, maxAmount });
    const status = result.accepted ? (result.duplicate ? 200 : 201) : STATUS_BY_REASON[result.reason] || 400;
    if (result.auction) result.auction = realtime.decorate(result.auction);
    res.status(status).json({ ...result, serverTime: Date.now() });
  });

  api.get('/auctions/:id/verify', (req, res) => {
    const report = house.verify(req.params.id);
    if (!report) return res.status(404).json({ reason: REASONS.NOT_FOUND });
    res.json(report);
  });

  /** Fire N simultaneous bids through the real HTTP stack, then verify invariants. */
  api.post('/auctions/:id/stress', async (req, res, next) => {
    try {
      const auction = house.get(req.params.id);
      if (!auction) return res.status(404).json({ reason: REASONS.NOT_FOUND });
      if (auction.status !== 'open') return res.status(409).json({ reason: REASONS.AUCTION_CLOSED });
      const count = Math.max(1, Math.min(1000, Number(req.body?.count) || 200));
      const base = `http://127.0.0.1:${server.address().port}/api/auctions/${encodeURIComponent(auction.id)}/bids`;
      const amounts = Array.from({ length: count }, (_, i) => auction.minNextBid + i * auction.minIncrement);
      shuffle(amounts);

      const client = createClient();
      const tag = Date.now().toString(36);
      const t0 = Date.now();
      const results = await Promise.all(
        amounts.map((amount, i) => client.post(base, { bidId: `stress-${tag}-${i}`, bidder: `stress-${tag}-${i}`, amount })),
      );
      const ms = Date.now() - t0;
      client.close();

      const tally = { leading: 0, outbid: 0, rejected: 0 };
      for (const r of results) {
        if (!r.body.accepted) tally.rejected++;
        else if (r.body.outcome === 'OUTBID') tally.outbid++;
        else tally.leading++;
      }
      const after = house.get(auction.id);
      res.json({
        sent: count,
        ms,
        ...tally,
        highestSent: Math.max(...amounts),
        finalPrice: after.currentPrice,
        highestWon: after.currentPrice === Math.max(...amounts),
        verify: house.verify(auction.id),
      });
    } catch (err) {
      next(err);
    }
  });

  api.get('/users/:name/activity', (req, res) => {
    res.json({ bidder: req.params.name, items: house.activity(req.params.name), serverTime: Date.now() });
  });

  // Simulated bidders: a runtime switch, so a real user can bid without competition and win.
  api.get('/demo/bots', (req, res) => res.json({ enabled: bots.enabled }));
  api.post('/demo/bots', (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    res.json({ enabled: bots.set(enabled) });
  });

  api.get('/stats', (req, res) => res.json(getStats()));

  /** What is stored in the database right now (table counts + latest rows). */
  api.get('/db', (req, res) => {
    if (!db) return res.json({ enabled: false });
    res.json({ enabled: true, ...db.stats(), recentBids: db.recentBids(8), serverTime: Date.now() });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: `No API route ${req.method} ${req.originalUrl}` }));

  // Unknown pages get a friendly 404 with a way back instead of a bare "Cannot GET".
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Not found · Lotline</title><body style="font-family:system-ui;background:#f4f2ed;color:#1c1b19;display:grid;place-items:center;min-height:100vh;margin:0">
      <div style="text-align:center"><h1 style="font-weight:500">Page not found</h1><p style="color:#5f5c55">Nothing lives at <code>${req.path.replace(/[<>&"]/g, '')}</code>.</p>
      <p><a href="/" style="color:#8a5a2b">Back to live auctions</a></p></div></body>`);
  });

  // JSON errors, including malformed request bodies.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  function close() {
    return new Promise((resolve) => {
      bots.stop();
      realtime.stop();
      limiter.stop();
      io.close();
      server.close(() => {
        if (db) db.close();
        resolve();
      });
    });
  }

  return { app, server, io, house, metrics, realtime, db, restored, placeBid, bots, close };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo') || process.env.DEMO === '1';
  const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'lotline.db');
  if (args.includes('--reset')) for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });

  const ctx = createServer({ dbFile, bots: demo });
  console.log(`Database: ${path.relative(process.cwd(), dbFile)} (SQLite)`);
  if (ctx.restored.replayed) console.log(`Restored ${ctx.restored.replayed} commands from the database`);
  if (ctx.house.list().length === 0) seedDemo(ctx.house);

  const port = Number(process.env.PORT) || 3000;
  ctx.server.listen(port, () => {
    console.log(`Live auctions running at http://localhost:${port}${demo ? '  (demo bots on)' : ''}`);
  });
  const shutdown = () => ctx.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
