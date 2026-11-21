'use strict';

const fs = require('fs');
const path = require('path');

// node:sqlite ships with Node 22.5+ (no install, no native build). Silence only
// its one-time "experimental" notice; every other warning still prints.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (String(warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emitWarning;

/**
 * SQLite storage.
 *
 *   commands  append-only write-ahead log of every accepted command (source of truth).
 *             Replayed on start-up to rebuild the engine exactly, hidden auto-bid maxima included.
 *   auctions  one row per lot, kept up to date on every change (read model / projection).
 *   bids      every bid-history entry, PRIMARY KEY (auction_id, seq): a duplicate is impossible.
 *   users     bidders and sellers seen so far.
 *
 * The projection tables are written in the same synchronous step as the
 * command, and rebuilt from the engine after every restart, so they can never
 * drift from the log. Production version: Postgres (same schema) + Kafka for the log.
 */
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS commands (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL CHECK (type IN ('create', 'bid')),
    at         INTEGER NOT NULL,
    auction_id TEXT    NOT NULL,
    payload    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auctions (
    id             TEXT PRIMARY KEY,
    title          TEXT    NOT NULL,
    description    TEXT    NOT NULL DEFAULT '',
    category       TEXT    NOT NULL,
    seller         TEXT    NOT NULL,
    palette        INTEGER NOT NULL DEFAULT 0,
    starting_price INTEGER NOT NULL CHECK (starting_price > 0),
    min_increment  INTEGER NOT NULL CHECK (min_increment > 0),
    has_reserve    INTEGER NOT NULL DEFAULT 0,
    status         TEXT    NOT NULL CHECK (status IN ('scheduled', 'open', 'closed')),
    current_price  INTEGER,
    leader         TEXT,
    bid_count      INTEGER NOT NULL DEFAULT 0,
    extensions     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    starts_at      INTEGER NOT NULL,
    ends_at        INTEGER NOT NULL,
    closed_at      INTEGER,
    outcome        TEXT,
    winner         TEXT,
    winning_amount INTEGER
  );
  CREATE INDEX IF NOT EXISTS auctions_status_ends ON auctions (status, ends_at);

  CREATE TABLE IF NOT EXISTS bids (
    auction_id TEXT    NOT NULL REFERENCES auctions (id),
    seq        INTEGER NOT NULL,
    bidder     TEXT    NOT NULL,
    amount     INTEGER NOT NULL CHECK (amount > 0),
    auto       INTEGER NOT NULL DEFAULT 0,
    tie        INTEGER NOT NULL DEFAULT 0,
    at         INTEGER NOT NULL,
    PRIMARY KEY (auction_id, seq)
  );
  CREATE INDEX IF NOT EXISTS bids_bidder ON bids (bidder, at);

  CREATE TABLE IF NOT EXISTS users (
    name       TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    bids       INTEGER NOT NULL DEFAULT 0,
    listings   INTEGER NOT NULL DEFAULT 0
  );
`;

class Store {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);

    const q = (sql) => this.db.prepare(sql);
    this.sql = {
      insertCommand: q('INSERT INTO commands (type, at, auction_id, payload) VALUES (?, ?, ?, ?)'),
      allCommands: q('SELECT type, at, auction_id, payload FROM commands ORDER BY id'),
      upsertAuction: q(`
        INSERT INTO auctions (id, title, description, category, seller, palette, starting_price, min_increment, has_reserve,
          status, current_price, leader, bid_count, extensions, created_at, starts_at, ends_at, closed_at, outcome, winner, winning_amount)
        VALUES (:id, :title, :description, :category, :seller, :palette, :startingPrice, :minIncrement, :hasReserve,
          :status, :currentPrice, :leader, :bidCount, :extensions, :createdAt, :startsAt, :endsAt, :closedAt, :outcome, :winner, :winningAmount)
        ON CONFLICT (id) DO UPDATE SET
          status = excluded.status, current_price = excluded.current_price, leader = excluded.leader,
          bid_count = excluded.bid_count, extensions = excluded.extensions, ends_at = excluded.ends_at,
          closed_at = excluded.closed_at, outcome = excluded.outcome, winner = excluded.winner,
          winning_amount = excluded.winning_amount`),
      insertBid: q('INSERT INTO bids (auction_id, seq, bidder, amount, auto, tie, at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      history: q('SELECT seq, bidder, amount, auto, tie, at FROM bids WHERE auction_id = ? ORDER BY seq DESC LIMIT ?'),
      recentBids: q(`SELECT b.auction_id, a.title, b.seq, b.bidder, b.amount, b.auto, b.at
                     FROM bids b JOIN auctions a ON a.id = b.auction_id ORDER BY b.at DESC, b.seq DESC LIMIT ?`),
      touchUser: q(`INSERT INTO users (name, first_seen, last_seen, bids, listings) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (name) DO UPDATE SET last_seen = excluded.last_seen,
                      bids = bids + excluded.bids, listings = listings + excluded.listings`),
      counts: q(`SELECT (SELECT COUNT(*) FROM commands) AS commands, (SELECT COUNT(*) FROM auctions) AS auctions,
                        (SELECT COUNT(*) FROM bids) AS bids, (SELECT COUNT(*) FROM users) AS users`),
    };
    this.count = this.sql.counts.get().commands;
  }

  // ---------------------------------------------------------- write-ahead log (engine `log` interface)

  /** Called by the engine for every accepted command, before anyone is told it succeeded. */
  append(event) {
    const auctionId = event.type === 'create' ? event.input.id : event.auctionId;
    const payload = event.type === 'create' ? event.input : event.cmd;
    this.sql.insertCommand.run(event.type, event.at, auctionId, JSON.stringify(payload));
    if (event.type === 'create') this.sql.touchUser.run(payload.seller, event.at, event.at, 0, 1);
    else this.sql.touchUser.run(payload.bidder, event.at, event.at, 1, 0);
    this.count++;
  }

  readAll() {
    return this.sql.allCommands.all().map((row) => {
      const payload = JSON.parse(row.payload);
      return row.type === 'create'
        ? { type: 'create', at: row.at, input: payload }
        : { type: 'bid', at: row.at, auctionId: row.auction_id, cmd: payload };
    });
  }

  // ---------------------------------------------------------- projection (queryable tables)

  /** Keep auctions/bids in step with an engine event. */
  project(type, auction, extra) {
    this.sql.upsertAuction.run(auctionRow(auction));
    if (type === 'bid') {
      for (const e of extra.entries) {
        this.sql.insertBid.run(auction.id, e.seq, e.bidder, e.amount, e.auto ? 1 : 0, e.tie ? 1 : 0, e.at);
      }
    }
  }

  /** After a replay: rewrite the read model from the engine so it can never drift. */
  rebuild(house) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM bids; DELETE FROM auctions;');
      for (const a of house.list()) {
        this.sql.upsertAuction.run(auctionRow(a));
        for (const e of house.history(a.id, Number.MAX_SAFE_INTEGER)) {
          this.sql.insertBid.run(a.id, e.seq, e.bidder, e.amount, e.auto ? 1 : 0, e.tie ? 1 : 0, e.at);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------------------------------------------------- queries

  history(auctionId, limit = 100) {
    return this.sql.history.all(auctionId, limit).reverse().map((r) => {
      const e = { seq: r.seq, bidder: r.bidder, amount: r.amount, auto: r.auto === 1, at: r.at };
      if (r.tie) e.tie = true;
      return e;
    });
  }

  recentBids(limit = 8) {
    return this.sql.recentBids.all(limit).map((r) => ({ ...r, auto: r.auto === 1 }));
  }

  stats() {
    const counts = { ...this.sql.counts.get() };
    let sizeKB = null;
    try {
      sizeKB = Math.round(fs.statSync(this.file).size / 1024);
    } catch {
      /* in-memory */
    }
    return { engine: 'SQLite (node:sqlite, WAL)', file: path.basename(this.file), sizeKB, ...counts };
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function auctionRow(a) {
  return {
    id: a.id,
    title: a.title,
    description: a.description || '',
    category: a.category,
    seller: a.seller,
    palette: a.palette ?? 0,
    startingPrice: a.startingPrice,
    minIncrement: a.minIncrement,
    hasReserve: a.hasReserve ? 1 : 0,
    status: a.status,
    currentPrice: a.currentPrice,
    leader: a.leader,
    bidCount: a.bidCount,
    extensions: a.extensions,
    createdAt: a.createdAt,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    closedAt: a.closedAt,
    outcome: a.outcome,
    winner: a.winner ? a.winner.bidder : null,
    winningAmount: a.winner ? a.winner.amount : null,
  };
}

module.exports = { Store };
