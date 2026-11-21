import {
  $, $$, api, boot, getSocket, startTicker, serverNow, fmt, animateNumber, pulse, flip, el, settle,
  cardHTML, patchCard, bindWatchButtons, segmented, CATEGORIES, artStyle, artInner, statusBadge,
  priceLabel, timeLabel, priceOf, countdownAttrs, esc,
} from './core.js';

boot('explore');

const state = {
  auctions: new Map(),
  filter: 'live',
  category: 'all',
  q: '',
  sort: 'ending',
  featuredId: null,
};
const cards = new Map(); // id -> element
const grid = $('#grid');

// ------------------------------------------------------------ filters
const catBar = $('#cats');
catBar.innerHTML =
  `<button class="chip active" data-cat="all">All categories</button>` +
  Object.entries(CATEGORIES).map(([k, c]) => `<button class="chip" data-cat="${k}">${c.icon}${c.label}</button>`).join('');
catBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  $$('.chip', catBar).forEach((c) => c.classList.toggle('active', c === b));
  state.category = b.dataset.cat;
  render();
});

segmented($('#statusSeg'), (v) => {
  state.filter = v;
  render();
});

let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    state.q = e.target.value.trim().toLowerCase();
    render();
  }, 120);
});
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  render();
});
bindWatchButtons(grid);
bindWatchButtons($('#featured'));

// ------------------------------------------------------------ selection
function matchesStatus(a, filter, now) {
  switch (filter) {
    case 'live': return a.status === 'open';
    case 'ending': return a.status === 'open' && a.endsAt - now < 10 * 60_000;
    case 'upcoming': return a.status === 'scheduled';
    case 'ended': return a.status === 'closed';
    default: return true;
  }
}

function visible() {
  const now = serverNow();
  const rank = { open: 0, scheduled: 1, closed: 2 };
  const sorters = {
    ending: (a, b) => rank[a.status] - rank[b.status] || (a.status === 'closed' ? b.endsAt - a.endsAt : a.status === 'scheduled' ? a.startsAt - b.startsAt : a.endsAt - b.endsAt),
    bids: (a, b) => b.bidCount - a.bidCount,
    price: (a, b) => priceOf(b) - priceOf(a),
    newest: (a, b) => b.createdAt - a.createdAt,
  };
  return [...state.auctions.values()]
    .filter((a) => matchesStatus(a, state.filter, now))
    .filter((a) => state.category === 'all' || a.category === state.category)
    .filter((a) => !state.q || `${a.title} ${a.seller} ${a.description}`.toLowerCase().includes(state.q))
    .sort(sorters[state.sort]);
}

// ------------------------------------------------------------ render
function render() {
  const list = visible();
  const ids = new Set(list.map((a) => a.id));
  $$('.skeleton', grid).forEach((s) => s.remove());

  flip(grid, () => {
    for (const [id, node] of cards) {
      if (!ids.has(id)) {
        node.remove();
        cards.delete(id);
      }
    }
    list.forEach((a, i) => {
      let node = cards.get(a.id);
      if (!node) {
        node = el(cardHTML(a, Math.min(i, 8)));
        settle(node);
        cards.set(a.id, node);
      }
      if (grid.children[i] !== node) grid.insertBefore(node, grid.children[i] || null);
    });
  });

  $('#empty').classList.toggle('hide', list.length > 0);
  updateCounts();
  renderFeatured();
  fixTransitionNames();
}

function updateCounts() {
  const now = serverNow();
  for (const key of ['live', 'ending', 'upcoming', 'ended']) {
    const n = [...state.auctions.values()].filter((a) => matchesStatus(a, key, now)).length;
    const c = $(`[data-count="${key}"]`);
    if (c && c.textContent !== String(n)) c.textContent = n;
  }
}

function renderFeatured() {
  const now = serverNow();
  const live = [...state.auctions.values()].filter((a) => a.status === 'open').sort((a, b) => a.endsAt - b.endsAt);
  const pick = live.find((a) => a.endsAt - now > 3000) || live[0] || [...state.auctions.values()].find((a) => a.status === 'scheduled');
  const host = $('#featured');
  if (!pick) {
    host.innerHTML = `<div class="glass empty"><h3>No live lots right now</h3><p class="muted">Check upcoming lots below.</p></div>`;
    state.featuredId = null;
    return;
  }
  if (pick.id === state.featuredId) {
    const priceEl = $('[data-price]', host);
    if (priceEl && Number(priceEl.dataset.value) !== priceOf(pick)) {
      animateNumber(priceEl, priceOf(pick));
      pulse(priceEl);
    }
    $('[data-badge]', host).innerHTML = statusBadge(pick);
    const cd = $('[data-countdown]', host);
    Object.assign(cd.dataset, { ends: pick.endsAt, starts: pick.startsAt, status: pick.status });
    $('[data-bids]', host).textContent = `${pick.bidCount} bids · ${pick.watchers ?? 0} watching`;
    return;
  }
  state.featuredId = pick.id;
  host.innerHTML = `
    <a class="featured glass glass-strong reveal" href="/auction?id=${encodeURIComponent(pick.id)}" data-id="${esc(pick.id)}" data-palette="${pick.palette ?? 0}">
      <div class="art" style="${artStyle(pick)};view-transition-name:art-${esc(pick.id)}">
        ${artInner(pick)}
        <span data-badge>${statusBadge(pick)}</span>
      </div>
      <div class="featured-body">
        <h3>${esc(pick.title)}</h3>
        <div>
          <div class="label">${priceLabel(pick)}</div>
          <div class="price num" data-price data-value="${priceOf(pick)}">${fmt.money(priceOf(pick))}</div>
        </div>
        <div>
          <div class="label" style="text-align:right">${timeLabel(pick)}</div>
          <div class="countdown" ${countdownAttrs(pick)}>—</div>
        </div>
        <div class="small muted" data-bids style="grid-column:1/-1">${pick.bidCount} bids · ${pick.watchers ?? 0} watching</div>
      </div>
    </a>`;
}

/** View-transition names must be unique on a page: the featured lot owns its name. */
function fixTransitionNames() {
  for (const [id, node] of cards) $('.art', node).style.viewTransitionName = id === state.featuredId ? 'none' : `art-${id}`;
}

function setSummary(s) {
  if (!s) return;
  animateNumber($('#hLive'), s.live, { format: fmt.int });
  animateNumber($('#hWatching'), s.watching, { format: fmt.int });
  animateNumber($('#hBids'), s.bidsLastMinute, { format: fmt.int });
  animateNumber($('#hUpcoming'), s.upcoming, { format: fmt.int });
  animateNumber($('#hEnded'), s.ended, { format: fmt.int });
}

function merge(list) {
  for (const a of list) {
    const prev = state.auctions.get(a.id);
    state.auctions.set(a.id, a);
    const node = cards.get(a.id);
    if (node) patchCard(node, a, prev);
  }
}

// ------------------------------------------------------------ data
(async () => {
  const r = await api.get('/auctions');
  if (r.ok) {
    merge(r.data.auctions);
    setSummary(r.data.summary);
    // If nothing is live, open on "All" so the page is never empty.
    if (!r.data.auctions.some((a) => a.status === 'open')) $('#statusSeg [data-value="all"]').click();
    render();
  }
})();

const socket = getSocket();
const join = () => socket.emit('lobby:join');
socket.on('connect', join);
if (socket.connected) join();
socket.on('lobby:snapshot', ({ auctions, summary }) => {
  merge(auctions);
  setSummary(summary);
  render();
});
socket.on('lobby:update', ({ auctions, summary }) => {
  merge(auctions);
  setSummary(summary);
  render();
});

// Statuses flip at exact times (start/end); re-evaluate filters every second.
let lastSecond = 0;
startTicker((now) => {
  const s = Math.floor(now / 1000);
  if (s !== lastSecond) {
    lastSecond = s;
    updateCounts();
  }
});
