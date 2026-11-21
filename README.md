# Lotline: Live Auction Platform

A real-time auction platform. The bidding core is correct under concurrency, all data is stored in **SQLite**, and the UI updates live.

**What the brief asked for, and where it is:**

| Requirement | How it's met |
|---|---|
| Accept or reject each bid | `placeBid` in [`src/auction.js`](src/auction.js): integer amounts, starting price, minimum increment, open/closed/scheduled checks |
| +30s when a bid lands in the last 30s | Any bid that moves the price with ≤ 30s left adds 30s; the close timer is re-armed |
| Correct when many people bid at once | Each bid is one synchronous step, so there is a single writer per auction. Tests fire 500 simultaneous HTTP bids |
| Exactly one winner | Closing happens once, at the server's deadline. A late timer can't let a bid in, and `/verify` re-checks it |

**Beyond the brief** (features found on real auction platforms):

- **Auto-bidding (proxy bids):** give a hidden maximum and the engine bids for you, only as much as needed to stay in front. Ties go to the earlier bidder.
- **Hidden reserve price:** bidders see "reserve met / not met". The lot doesn't sell below it.
- **Scheduled lots,** a watchlist, categories, search and sort.
- **SQLite database** (`data/lotline.db`): tables `auctions`, `bids`, `users`, plus a `commands` write-ahead log. Every accepted command is stored before it's acknowledged. On restart the log is replayed into an identical state, including hidden auto-bid maximums.
- **Idempotent bids:** a retried request with the same `bidId` is never counted twice, even across restarts.
- **Batched real-time fan-out:** at most 10 messages/sec per auction, each with full state.
- **Per-bidder rate limiting,** live metrics, and a built-in **stress test + invariant checker**.

---

## Design note: 50,000 auctions, 200,000 watchers on one

1. **One owner per auction.** Auctions are split across servers by ID. Every bid for one auction goes to a single writer: a Redis shard running a Lua script, or one Kafka partition consumed by one worker. Bids for the same auction are processed one at a time with no distributed locks, and different auctions run fully in parallel. 50k auctions spread evenly across N shards.
2. **The bid check is one atomic step.** Check open → check ≥ price + increment → resolve auto-bids → write price and leader → extend the deadline if ≤ 30s are left. It all runs as **one atomic operation** (one Lua script, or one synchronous function as in this repo), so two bids can never both see the old price.
3. **The server clock decides.** The deadline is checked inside that same step, on the server's clock and never the client's. A timer closes the auction exactly once. If a bid arrives after `endsAt` before the timer has fired, the bid path closes the auction and rejects the bid. The winner is the leader at close, so there is never doubt about who won.
4. **Fan-out separated from bidding.** Auction owners publish changes to pub/sub (Redis or NATS). About 20 stateless WebSocket gateway servers, each holding around 10k connections, subscribe per auction. In the final-seconds rush, updates are **batched to ≤ 1 per 100ms** and carry the full latest state, so a dropped message never leaves a client wrong. 200k watchers cost one fan-out per batch, not one per bid.
5. **Durable, auditable storage.** Accepted commands are written to a `commands` table (SQLite here; Postgres + Kafka at scale) **before** the bidder is told "accepted". Queryable `auctions` / `bids` / `users` tables are kept in step, with `PRIMARY KEY (auction_id, seq)` so a duplicate bid can't exist even at the database level. A crashed owner is rebuilt by replaying the log.
6. **Safety at the edges.** Client-generated `bidId`s make retries idempotent. Bidders are authenticated and rate-limited at the gateway, and money is stored as integers (paise/cents), never floats.

---

## Run it

```bash
npm install
npm run demo     # fresh demo data + simulated bidders → http://localhost:3000
npm start        # same server, no bots, keeps data/lotline.db between restarts
npm test         # 28 tests: engine rules, auto-bid, reserve, timing, replay, HTTP concurrency, SQLite storage, restart
```

Things to try:
- Open a lot in **two browser windows** and bid from both. The price, history and countdown update live in each.
- Turn on **auto-bid** with a high max, then out-bid yourself from the other window to watch the proxy answer instantly.
- Bid in the **last 30 seconds**: the clock extends and a banner appears for everyone watching.
- On **System**, run the **stress test** (up to 1,000 simultaneous bids through real HTTP), then read the invariant checks.
- **Restart the server** (`npm start`): every lot, bid and hidden max is restored from the database.
- The **System** page's Database panel shows the row counts and the latest rows of the `bids` table, read live from SQLite.

> Requires Node 22.5+ (uses the built-in `node:sqlite`, so nothing to install or compile). After pulling new code, **restart the server**: an old process keeps serving old routes.

## Pages

| Page | What it shows |
|---|---|
| **Explore** `/` | Hero with live stats and a featured lot ending soonest; filters (live / ending soon / upcoming / ended), categories, search and sort; cards reorder with smooth FLIP animation |
| **Lot** `/auction?id=` | Big art that morphs in from the card (View Transitions API), live price counter, countdown ring that turns red in the final 30s, quick-bid chips, auto-bid, bid history, result modal with confetti on a win, invariant "Verify" button |
| **Sell** `/sell` | Listing form with live card preview, category and style pickers, reserve, duration and scheduled start |
| **My bids** `/activity` | Winning / outbid / won / lost / watching, updating live |
| **System** `/system` | Bids per second chart, engine latency p50/p99, sockets, stress test, live database panel, architecture diagram |

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/auctions?status=live\|ending\|upcoming\|ended\|all&category=&q=&sort=ending\|bids\|price\|newest` | list |
| `POST` | `/api/auctions` | `{ title, description, category, palette, startingPrice, minIncrement, reservePrice?, durationSeconds, startsInSeconds?, seller }` |
| `GET` | `/api/auctions/:id` | auction + last 50 history entries |
| `POST` | `/api/auctions/:id/bids` | `{ bidId, bidder, amount, maxAmount? }` → `201` with `outcome: LEADING \| OUTBID \| MAX_RAISED`, `200` duplicate retry, `400` invalid, `404`, `409` too low / closed / not started / already leading, `429` rate limited |
| `GET` | `/api/auctions/:id/verify` | recompute invariants from the full history |
| `POST` | `/api/auctions/:id/stress` | `{ count }`: fires N simultaneous bids through HTTP, returns tallies + verification |
| `GET` | `/api/users/:name/activity` | a bidder's lots and state (hidden maximums are never exposed) |
| `GET` | `/api/auctions/:id/history?limit=` | full bid history, read from SQLite |
| `GET` | `/api/db` | database table counts + latest stored bids |
| `GET` | `/api/stats` · `/api/time` | metrics · server clock |

WebSocket rooms: `auction:<id>` (`auction:snapshot`, `auction:update`, `auction:closed`), `lobby` (`lobby:snapshot`, `lobby:update`), `stats`.

## Code map

```
src/auction.js     the engine: rules, auto-bid, reserve, timers, verify, replay   ← the core
src/server.js      Express API, single bid entry point, stress test, static files
src/realtime.js    Socket.io rooms, watcher counts, 100ms coalescing
src/db.js          SQLite storage: commands log + auctions/bids/users tables
src/metrics.js     throughput ring buffer, latency percentiles
src/rate-limit.js  token bucket per bidder
src/demo.js        seed lots + simulated bidders with private valuations
public/            5 pages, minimal editorial design system (css/app.css), shared JS (js/core.js)
test/              engine tests with a fake clock; HTTP, rate-limit and restart tests
```

## Key decisions and trade-offs

- **Single writer instead of locks.** `placeBid` is synchronous end to end. Node runs one call at a time, so the read-check-write can't interleave. This is the per-auction single-writer model from the design note, at the size of one process.
- **Auto-bid rules.** A challenger above the leader's max wins at `max(their bid, leaderMax + increment)`, capped at their own max. A challenger at or below it is answered at `min(leaderMax, theirMax + increment)`, and on a tie the earlier bidder keeps the lead. The leader can only raise their own max, which never raises the price.
- **What counts as a late bid.** Only a bid that *moves the price* with ≤ 30s left extends the auction. Raising your own hidden max doesn't, because it would let a leader stall the auction. The rule is literally `endsAt += 30s`. Resetting to `now + 30s` instead is a one-line change.
- **Write-ahead log in SQLite.** The command row is inserted (WAL mode) before the response and broadcast. The `auctions`/`bids` tables are a projection: written in the same step and rebuilt from the log on start-up, so they can't drift. At scale it would be Postgres + a Kafka produce with acks.
- **Every countdown uses the server's clock.** The browser estimates its offset NTP-style from `/api/time`, so a wrong device clock can't mislead a bidder.
- **Frontend has no build step.** It's plain ES modules. The look is deliberately quiet (paper background, ink, serif headings, one bronze accent), with subtle frosted glass on the nav and panels, View Transitions between pages, FLIP reordering and smooth number counters. All motion respects `prefers-reduced-motion`.

## Not done (next steps)

- Real authentication (bidder names are honour-system in this demo)
- Postgres/Kafka in place of SQLite, with log compaction or snapshots
- Horizontal scale-out: shard owners + gateway tier as in the design note
- Payments and seller payouts after a win, plus a notification service ("you've been outbid" email or push)
#   t e c h _ a h i r  
 