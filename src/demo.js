'use strict';

/**
 * Demo data + simulated bidders, so the platform looks alive during a demo.
 * Bots go through exactly the same code path as real HTTP bids.
 */

const SEED = [
  { title: '1962 Field Chronograph', category: 'watches', palette: 5, startingPrice: 42000, minIncrement: 1000, reservePrice: 60000, mins: 3,
    description: 'Hand-wound chronograph with a 38mm steel case, original dial and a fresh service. Light patina on the hands, crisp pushers.' },
  { title: 'Rangefinder Camera, 35mm', category: 'cameras', palette: 3, startingPrice: 18000, minIncrement: 500, mins: 6,
    description: 'Fully mechanical rangefinder with a bright viewfinder. Shutter tested at all speeds. Comes with a 50mm f/2 lens and leather strap.' },
  { title: 'Abstract Study No. 7', category: 'art', palette: 1, startingPrice: 75000, minIncrement: 2500, reservePrice: 120000, mins: 12,
    description: 'Oil on linen, 90 × 120 cm. Layered warm fields over a cool ground, signed and dated on the reverse. Gallery-wrapped.' },
  { title: 'Hand-built Hi-top Sneakers', category: 'sneakers', palette: 7, startingPrice: 9000, minIncrement: 250, mins: 45,
    description: 'Made-to-order high-tops in full-grain leather, size UK 9. Never worn, includes the original box and spare laces.' },
  { title: 'First-edition Comic, graded 9.4', category: 'collectibles', palette: 4, startingPrice: 30000, minIncrement: 1000, mins: 120,
    description: 'Sealed in an archival slab with a 9.4 grade. White pages, sharp corners, vivid cover colours.' },
  { title: 'Sunburst Electric Guitar, 1974', category: 'music', palette: 6, startingPrice: 55000, minIncrement: 1500, reservePrice: 70000, mins: 25,
    description: 'Solid-body electric with a three-tone sunburst finish. Original pickups, refretted, plays effortlessly. Hard case included.' },
  { title: 'Custom Mechanical Keyboard', category: 'tech', palette: 0, startingPrice: 12000, minIncrement: 500, mins: 1.5,
    description: 'Brass-weighted 65% board with lubed linear switches and hand-dyed keycaps. Hot-swap PCB, USB-C.' },
  { title: 'Vintage Film Poster Collection', category: 'collectibles', palette: 2, startingPrice: 15000, minIncrement: 500, mins: 10, startsInMins: 4,
    description: 'Twelve original theatrical posters from the 1970s, linen-backed and stored flat. A rare complete set.' },
];

const BOTS = ['kestrel', 'mira_k', 'atlas.collects', 'jun_o', 'harbor_lane', 'nova', 'pixel_pete', 'saanvi.r', 'orchid', 'tomas_v', 'ivy-bids', 'deepak_m'];
const SELLERS = ['Northlight Vintage', 'Studio Ferro', 'The Archive Room', 'Kiln & Co.', 'Old Mill Traders'];

function slug(title) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

function seedDemo(house) {
  const now = Date.now();
  SEED.forEach((item, i) => {
    house.create({
      id: slug(item.title),
      title: item.title,
      description: item.description,
      category: item.category,
      palette: item.palette,
      seller: SELLERS[i % SELLERS.length],
      startingPrice: item.startingPrice,
      minIncrement: item.minIncrement,
      reservePrice: item.reservePrice ?? null,
      startsAt: now + Math.round((item.startsInMins ?? 0) * 60_000),
      durationMs: Math.round(item.mins * 60_000),
    });
  });
}

/**
 * Simulated bidders, switchable at runtime (the "Simulated bidders" switch in the UI).
 * Each bot has a private valuation per item, so bidding wars end naturally, and
 * they get more aggressive near the deadline, which exercises anti-sniping.
 * Turned off, nobody bids except real users, so a lot closes on schedule.
 */
function createBots({ house, placeBid }, { enabled = false, minDelayMs = 700, maxDelayMs = 2200, onChange = () => {} } = {}) {
  const valuations = new Map(); // `${bot}|${id}` -> max they will ever pay
  const valuation = (bot, a) => {
    const key = `${bot}|${a.id}`;
    if (!valuations.has(key)) {
      const base = a.hasReserve ? a.startingPrice * 1.5 : a.startingPrice;
      const raw = base * (1.1 + Math.random() * 1.6);
      valuations.set(key, Math.round(raw / a.minIncrement) * a.minIncrement); // keep prices on the increment grid
    }
    return valuations.get(key);
  };

  let timer = null;
  let relist = null;

  const tick = () => {
    if (!state.enabled) return;
    const now = Date.now();
    const open = house.list().filter((a) => a.status === 'open');
    if (open.length) {
      // Weight auctions that are ending soon much higher.
      const weighted = open.flatMap((a) => {
        const left = a.endsAt - now;
        const w = left < 30_000 ? 8 : left < 120_000 ? 3 : 1;
        return Array(w).fill(a);
      });
      const a = weighted[Math.floor(Math.random() * weighted.length)];
      const bot = BOTS[Math.floor(Math.random() * BOTS.length)];
      const cap = valuation(bot, a);
      if (a.leader !== bot && a.minNextBid <= cap) {
        const jump = Math.random() < 0.25 ? Math.floor(Math.random() * 3) : 0;
        const amount = Math.min(cap, a.minNextBid + jump * a.minIncrement);
        const useMax = Math.random() < 0.3 && cap > amount;
        placeBid(a.id, {
          bidId: `bot-${now}-${Math.random().toString(36).slice(2, 8)}`,
          bidder: bot,
          amount,
          maxAmount: useMax ? Math.min(cap, amount + a.minIncrement * (2 + Math.floor(Math.random() * 6))) : null,
        });
      }
    }
    timer = setTimeout(tick, minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
    timer.unref();
  };

  // Keep the demo alive: relist a fresh lot whenever few are running.
  const relistTick = () => {
    const active = house.list().filter((a) => a.status !== 'closed').length;
    if (active >= 4) return;
    const item = SEED[Math.floor(Math.random() * SEED.length)];
    house.create({
      id: slug(item.title),
      title: item.title,
      description: item.description,
      category: item.category,
      palette: Math.floor(Math.random() * 8),
      seller: SELLERS[Math.floor(Math.random() * SELLERS.length)],
      startingPrice: item.startingPrice,
      minIncrement: item.minIncrement,
      reservePrice: item.reservePrice ?? null,
      durationMs: (2 + Math.floor(Math.random() * 6)) * 60_000,
    });
  };

  const state = {
    enabled: false,
    set(on) {
      on = Boolean(on);
      if (on === state.enabled) return state.enabled;
      state.enabled = on;
      clearTimeout(timer);
      clearInterval(relist);
      if (on) {
        relist = setInterval(relistTick, 20_000);
        relist.unref();
        tick();
      }
      onChange(on);
      return on;
    },
    stop() {
      state.enabled = false;
      clearTimeout(timer);
      clearInterval(relist);
    },
  };
  if (enabled) state.set(true);
  return state;
}

module.exports = { seedDemo, createBots, slug };
