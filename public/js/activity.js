import {
  $, api, boot, getSocket, startTicker, fmt, animateNumber, user, watchlist, avatar, esc, segmented, ICONS,
  artStyle, artInner, countdownAttrs, timeLabel, priceOf, CATEGORIES,
} from './core.js';

boot('activity');

let tab = 'active';
let items = []; // from /users/:name/activity
let watched = []; // auctions on the watchlist

segmented($('#tabs'), (v) => {
  tab = v;
  renderList();
});

function renderProfile() {
  const name = user.name();
  $('#profile').innerHTML = name
    ? `${avatar(name, 'lg')}<div class="grow"><div class="label">Bidding as</div><h1 class="h2" style="margin-top:2px">${esc(name)}</h1></div>
       <button class="btn btn-sm" id="rename">${ICONS.user}Change name</button>`
    : `<div class="grow"><h1 class="h2">Your bidding activity</h1><p class="muted" style="margin:6px 0 0">Pick a bidder name to track lots you're winning, outbid on and have won.</p></div>
       <button class="btn btn-primary" id="rename">${ICONS.user}Pick a name</button>`;
  $('#rename').addEventListener('click', async () => {
    if (await user.prompt()) {
      renderProfile();
      load();
    }
  });
}

const STATE_PILL = {
  leading: `<span class="pill ok">${ICONS.trophy}Winning</span>`,
  outbid: `<span class="pill bad">${ICONS.alert}Outbid</span>`,
  won: `<span class="pill ok">${ICONS.check}Won</span>`,
  lost: `<span class="pill info">Lost</span>`,
  watching: `<span class="pill info">${ICONS.heart}Watching</span>`,
};

function row(a, { state, yourHighest }, i) {
  const cat = CATEGORIES[a.category] || CATEGORIES.collectibles;
  return `
  <a class="act-row glass reveal" style="--i:${Math.min(i, 8)}" href="/auction?id=${encodeURIComponent(a.id)}" data-id="${esc(a.id)}" data-palette="${a.palette ?? 0}">
    <div class="art thumb" style="${artStyle(a)};view-transition-name:art-${esc(a.id)}">${artInner(a)}</div>
    <div class="info">
      <div class="tiny faint">${cat.label} · ${esc(a.seller)}</div>
      <h3>${esc(a.title)}</h3>
      <div class="row" style="margin-top:6px;gap:8px">${STATE_PILL[state] || ''}</div>
    </div>
    <div class="nums">
      ${yourHighest ? `<div class="hide-sm"><div class="label">Your top bid</div><div class="v">${fmt.money(yourHighest)}</div></div>` : ''}
      <div><div class="label">${a.status === 'closed' ? 'Final' : 'Current'}</div><div class="v">${fmt.money(priceOf(a))}</div></div>
      <div class="hide-sm"><div class="label">${timeLabel(a)}</div><div class="v countdown" ${countdownAttrs(a)}>—</div></div>
    </div>
  </a>`;
}

function renderList() {
  const groups = {
    active: items.filter((x) => x.state === 'leading' || x.state === 'outbid'),
    won: items.filter((x) => x.state === 'won'),
    lost: items.filter((x) => x.state === 'lost'),
    watching: watched.map((a) => ({ auction: a, state: 'watching', yourHighest: items.find((x) => x.auction.id === a.id)?.yourHighest })),
  };
  for (const [k, v] of Object.entries(groups)) $(`[data-count="${k}"]`).textContent = v.length;

  const list = groups[tab];
  if (!list.length) {
    const msg = {
      active: ['No active bids', 'Find something you like on the Explore page.'],
      won: ['No wins yet', 'Lots you win will show up here.'],
      lost: ['Nothing lost', 'Lots you bid on but did not win show up here.'],
      watching: ['Your watchlist is empty', 'Tap the heart on any lot to follow it.'],
    }[tab];
    $('#list').innerHTML = `<div class="empty glass reveal">${ICONS.search}<h3>${msg[0]}</h3><p class="muted">${msg[1]}</p><a class="btn btn-primary" href="/" style="margin-top:8px">Explore lots</a></div>`;
    return;
  }
  // Live lots first, soonest ending first.
  list.sort((x, y) => (x.auction.status === 'closed') - (y.auction.status === 'closed') || x.auction.endsAt - y.auction.endsAt);
  $('#list').innerHTML = list.map((x, i) => row(x.auction, x, i)).join('');
}

function renderTiles() {
  const won = items.filter((x) => x.state === 'won');
  animateNumber($('#tLeading'), items.filter((x) => x.state === 'leading').length, { format: fmt.int });
  animateNumber($('#tOutbid'), items.filter((x) => x.state === 'outbid').length, { format: fmt.int });
  animateNumber($('#tWon'), won.length, { format: fmt.int });
  animateNumber($('#tWatch'), watched.length, { format: fmt.int });
  $('#tWonValue').textContent = `${fmt.money(won.reduce((s, x) => s + x.auction.currentPrice, 0))} total`;
}

let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  try {
    const name = user.name();
    const ids = watchlist.all();
    const [act, watch] = await Promise.all([
      name ? api.get(`/users/${encodeURIComponent(name)}/activity`) : Promise.resolve({ ok: true, data: { items: [] } }),
      ids.length ? api.get(`/auctions?status=all&ids=${ids.map(encodeURIComponent).join(',')}`) : Promise.resolve({ ok: true, data: { auctions: [] } }),
    ]);
    const before = JSON.stringify([items.map((x) => [x.auction.id, x.state, x.auction.currentPrice, x.auction.status]), watched.map((a) => [a.id, a.currentPrice, a.status])]);
    if (act.ok) items = act.data.items;
    if (watch.ok) watched = watch.data.auctions;
    const after = JSON.stringify([items.map((x) => [x.auction.id, x.state, x.auction.currentPrice, x.auction.status]), watched.map((a) => [a.id, a.currentPrice, a.status])]);
    renderTiles();
    if (before !== after || !$('#list').children.length) renderList();
  } finally {
    loading = false;
  }
}

renderProfile();
load();
startTicker();

// Refresh when anything changes in the marketplace (throttled).
const socket = getSocket();
const join = () => socket.emit('lobby:join');
socket.on('connect', join);
if (socket.connected) join();
let refreshTimer = null;
socket.on('lobby:update', ({ auctions }) => {
  if (!auctions.length || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    load();
  }, 1200);
});
