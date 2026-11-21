'use strict';

/**
 * Socket.io fan-out with coalescing.
 *
 * Engine events are not sent one-by-one. Per auction we keep the latest state
 * plus the new history entries, and flush at most every 100ms. In the
 * final-seconds rush of a hot auction, 500 bids/sec become 10 messages/sec per
 * watcher — and each message carries the full latest state, so a dropped one
 * never leaves a client wrong.
 *
 * Rooms:
 *   auction:<id>  watchers of one auction (room size = live watcher count)
 *   lobby         the Explore page (batched every 500ms)
 *   stats         the System page (metrics every second)
 */
class Realtime {
  constructor({ io, house, metrics, getStats, auctionFlushMs = 100, lobbyFlushMs = 500 }) {
    this.io = io;
    this.house = house;
    this.metrics = metrics;
    this.getStats = getStats;
    this.pending = new Map(); // auctionId -> { auction, entries, extended }
    this.lobbyDirty = new Set();
    this.lobbyTick = 0;

    this.timers = [
      setInterval(() => this.flush(), auctionFlushMs),
      setInterval(() => this.flushLobby(), lobbyFlushMs),
      setInterval(() => this.pushStats(), 1000),
    ];
    this.timers.forEach((t) => t.unref());

    io.on('connection', (socket) => this.#onConnection(socket));
  }

  room(id) {
    return `auction:${id}`;
  }

  watchers(id) {
    return this.io.sockets.adapter.rooms.get(this.room(id))?.size ?? 0;
  }

  decorate(auction) {
    return auction ? { ...auction, watchers: this.watchers(auction.id) } : auction;
  }

  /** Called synchronously by the engine after every state change. */
  onEvent(type, auction, extra) {
    this.lobbyDirty.add(auction.id);
    const p = this.#pendingFor(auction.id);
    p.auction = auction;
    if (type === 'bid') {
      p.entries.push(...extra.entries);
      p.extended = p.extended || extra.extended;
    }
    if (type === 'closed') {
      // Close is sent immediately and never coalesced away.
      this.flush(auction.id);
      this.io.to(this.room(auction.id)).emit('auction:closed', { auction: this.decorate(auction), serverTime: Date.now() });
    }
  }

  flush(onlyId) {
    const ids = onlyId ? [onlyId] : [...this.pending.keys()];
    for (const id of ids) {
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      const auction = p.auction || this.house.get(id);
      this.io.to(this.room(id)).emit('auction:update', {
        auction: this.decorate(auction),
        entries: p.entries,
        extended: p.extended,
        serverTime: Date.now(),
      });
    }
  }

  flushLobby() {
    this.lobbyTick++;
    if (this.lobbyDirty.size === 0 && this.lobbyTick % 4 !== 0) return;
    const auctions = [...this.lobbyDirty].map((id) => this.decorate(this.house.get(id))).filter(Boolean);
    this.lobbyDirty.clear();
    this.io.to('lobby').emit('lobby:update', { auctions, summary: this.summary(), serverTime: Date.now() });
  }

  pushStats() {
    if ((this.io.sockets.adapter.rooms.get('stats')?.size ?? 0) === 0) return;
    this.io.to('stats').emit('stats', this.getStats());
  }

  summary() {
    const s = this.house.stats();
    let watching = 0;
    for (const [name, members] of this.io.sockets.adapter.rooms) {
      if (name.startsWith('auction:')) watching += members.size;
    }
    return {
      live: s.open,
      upcoming: s.scheduled,
      ended: s.closed,
      bidsLastMinute: this.metrics.series().reduce((sum, n) => sum + n, 0),
      watching,
      online: this.io.engine.clientsCount,
    };
  }

  #pendingFor(id) {
    let p = this.pending.get(id);
    if (!p) {
      p = { auction: null, entries: [], extended: false };
      this.pending.set(id, p);
    }
    return p;
  }

  #watchersChanged(id) {
    if (!this.house.get(id)) return;
    this.#pendingFor(id);
    this.lobbyDirty.add(id);
  }

  #onConnection(socket) {
    socket.on('lobby:join', () => {
      socket.join('lobby');
      socket.emit('lobby:snapshot', {
        auctions: this.house.list().map((a) => this.decorate(a)),
        summary: this.summary(),
        serverTime: Date.now(),
      });
    });

    socket.on('auction:join', (rawId) => {
      const id = String(rawId);
      const auction = this.house.get(id);
      if (!auction) return socket.emit('auction:error', { reason: 'NOT_FOUND' });
      for (const r of socket.rooms) {
        if (r.startsWith('auction:') && r !== this.room(id)) {
          socket.leave(r);
          this.#watchersChanged(r.slice(8));
        }
      }
      socket.join(this.room(id));
      this.#watchersChanged(id);
      socket.emit('auction:snapshot', {
        auction: this.decorate(auction),
        history: this.house.history(id, 50),
        serverTime: Date.now(),
      });
    });

    socket.on('auction:leave', (rawId) => {
      socket.leave(this.room(String(rawId)));
      this.#watchersChanged(String(rawId));
    });

    socket.on('stats:join', () => {
      socket.join('stats');
      socket.emit('stats', this.getStats());
    });

    socket.on('disconnecting', () => {
      const ids = [...socket.rooms].filter((r) => r.startsWith('auction:')).map((r) => r.slice(8));
      // Room membership is updated after this handler; recount on the next tick.
      setImmediate(() => ids.forEach((id) => this.#watchersChanged(id)));
    });
  }

  stop() {
    this.timers.forEach(clearInterval);
  }
}

module.exports = { Realtime };
