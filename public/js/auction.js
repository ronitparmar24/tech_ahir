import {
  $, api, boot, getSocket, startTicker, fmt, animateNumber, pulse, el, esc, params, user, watchlist, myMax,
  toast, modal, confetti, avatar, reasonText, ICONS, CATEGORIES, PALETTES, mountBotsToggle, artInner, statusBadge, priceLabel, timeLabel, priceOf,
} from './core.js';

boot(null);
mountBotsToggle($('#botsSlot'));

const id = params.get('id');
const RING = 2 * Math.PI * 52;
let A = null; // latest auction snapshot
let lastSeq = 0;
let amountDirty = false;
let extTimer = null;

const amountEl = $('#amount');
const maxEl = $('#maxAmount');
const autoToggle = $('#autoToggle');
const me = () => user.name();

if (!id) notFound();

// ================================================================= render
function applyAuction(a, { extended = false } = {}) {
  const prev = A;
  A = a;
  const mine = me();

  if (!prev) {
    document.title = `${a.title} · Lotline`;
    const art = $('#art');
    art.insertAdjacentHTML('afterbegin', artInner(a));
    const [c1, c2, c3] = paletteOf(a);
    art.style.setProperty('--c1', c1);
    art.style.setProperty('--c2', c2);
    art.style.setProperty('--c3', c3);
    $('#title').textContent = a.title;
    $('#catLabel').textContent = (CATEGORIES[a.category] || CATEGORIES.collectibles).label;
    $('#lotId').textContent = `Lot ${a.id.split('-').pop().toUpperCase()}`;
    $('#seller').innerHTML = `${avatar(a.seller, 'sm')}<span>Sold by <b style="color:var(--text)">${esc(a.seller)}</b></span>`;
    $('#desc').textContent = a.description || 'No description provided.';
    const watched = watchlist.has(a.id);
    $('#watchBtn').classList.toggle('on', watched);
  }

  $('#badge').innerHTML = statusBadge(a);
  animateNumber($('#watchers'), a.watchers ?? 0, { format: fmt.int, duration: 400 });

  // price
  $('#priceLabel').textContent = priceLabel(a);
  const priceEl = $('#price');
  if (prev && priceOf(prev) !== priceOf(a)) {
    animateNumber(priceEl, priceOf(a));
    pulse(priceEl);
  } else {
    priceEl.textContent = fmt.money(priceOf(a));
    priceEl.dataset.value = priceOf(a);
  }

  // leader
  const leaderEl = $('#leader');
  if (a.status === 'closed') {
    leaderEl.innerHTML = a.winner
      ? `${avatar(a.winner.bidder, 'sm')}<span>Won by <b>${a.winner.bidder === mine ? 'you' : esc(a.winner.bidder)}</b></span>`
      : `<span>${a.outcome === 'RESERVE_NOT_MET' ? 'Reserve not met: no sale' : 'No bids were placed'}</span>`;
  } else if (a.leader) {
    leaderEl.innerHTML = `${avatar(a.leader, 'sm')}<span><b>${a.leader === mine ? 'You' : esc(a.leader)}</b> ${a.leader === mine ? 'are' : 'is'} the highest bidder</span>`;
  } else {
    leaderEl.innerHTML = `<span>No bids yet · opening bid ${fmt.money(a.startingPrice)}</span>`;
  }

  // reserve
  $('#reservePill').innerHTML = !a.hasReserve
    ? `<span class="pill info" style="padding:3px 10px;font-size:12px">No reserve</span>`
    : a.reserveMet
      ? `<span class="pill ok" style="padding:3px 10px;font-size:12px">${ICONS.check}Reserve met</span>`
      : `<span class="pill warn" style="padding:3px 10px;font-size:12px">${ICONS.lock}Reserve not met</span>`;

  // timer
  const cd = $('#countdown');
  Object.assign(cd.dataset, { ends: a.endsAt, starts: a.startsAt, status: a.status });
  $('#timeLabel').textContent = timeLabel(a);
  $('#endsAt').textContent =
    a.status === 'scheduled' ? `Opens ${fmt.dateTime(a.startsAt)}` : a.status === 'closed' ? `Closed ${fmt.dateTime(a.closedAt)}` : `Closes at ${fmt.clock(a.endsAt)}`;

  if (extended || (prev && a.extensions > prev.extensions)) showExtension(a);

  renderMyStatus(a);
  renderBidControls(a);
  renderDetails(a);
  $('#bidCount').textContent = a.bidCount;
  $('#bidderCount').textContent = a.bidderCount;

  // Outbid while watching?
  if (prev && mine && prev.leader === mine && a.leader !== mine && a.status === 'open') {
    toast("You've been outbid", `${a.leader} leads at ${fmt.money(a.currentPrice)}`, 'bad');
    pulse($('#panel'), 'shake');
  }

  if (a.status === 'closed') renderResult(a);
  if (prev && prev.status !== 'closed' && a.status === 'closed') announceClose(a);
}

function paletteOf(a) {
  return PALETTES[(a.palette ?? 0) % PALETTES.length];
}

function renderMyStatus(a) {
  const mine = me();
  const host = $('#myStatus');
  if (!mine) {
    host.innerHTML = '';
    return;
  }
  const bidHere = $('#hist').querySelector('li.me') || (a.leader === mine);
  let html = '';
  if (a.status === 'open' || a.status === 'scheduled') {
    if (a.leader === mine) {
      html += `<span class="pill ok">${ICONS.trophy}You're winning</span>`;
      const mx = myMax.get(a.id);
      if (mx && mx > a.currentPrice) html += `<span class="pill info">${ICONS.bolt}Auto-bid up to ${fmt.money(mx)}</span>`;
    } else if (bidHere) {
      html += `<span class="pill bad">${ICONS.alert}You've been outbid</span>`;
    }
  }
  host.innerHTML = html;
}

function renderBidControls(a) {
  const open = a.status === 'open';
  const mine = me();
  const leading = open && mine && a.leader === mine;
  const min = a.minNextBid ?? priceOf(a);
  const inc = a.minIncrement;

  // quick chips
  $('#quick').innerHTML = open
    ? [
        [min, 'Next bid'],
        [min + inc * 2, '+2 steps'],
        [min + inc * 5, '+5 steps'],
      ].map(([v, l]) => `<button type="button" class="qchip" data-v="${v}"><small>${l}</small>${fmt.money(v)}</button>`).join('')
    : '';
  $('#quick').style.display = open && !leading ? '' : 'none';

  // amount: follow the minimum unless the user typed their own (and it is still valid)
  if (open) {
    const cur = Number(amountEl.value);
    if (!amountDirty || !cur) amountEl.value = min;
    else if (cur < min) {
      amountEl.value = min;
      pulse(amountEl, 'flash');
    }
    amountEl.min = min;
    amountEl.step = 1;
  }

  if (leading && !autoToggle.checked) {
    autoToggle.checked = true;
    $('#autoBox').classList.add('open');
  }
  const stored = myMax.get(a.id);
  $('#maxHint').textContent = leading && stored ? `Your current max is ${fmt.money(stored)}. Enter a higher one to raise it.` : 'Your maximum stays private. Other bidders never see it.';

  const form = $('#bidForm');
  form.style.display = a.status === 'closed' ? 'none' : '';
  $('.stepper').style.display = leading ? 'none' : '';
  const btn = $('#bidBtn');
  btn.disabled = !open;
  $('#bidBtnText').textContent = a.status === 'scheduled' ? 'Bidding opens soon' : leading ? 'Raise my auto-bid max' : 'Place bid';
  $('#fine').textContent = `Minimum increment ${fmt.money(inc)}. Bids are binding. A bid in the last 30 seconds adds 30 seconds.`;
}

function renderDetails(a) {
  const rows = [
    ['Starting bid', fmt.money(a.startingPrice)],
    ['Increment', fmt.money(a.minIncrement)],
    ['Reserve', a.hasReserve ? (a.reserveMet ? 'Met' : 'Not yet met') : 'None'],
    ['Anti-sniping', a.extensions ? `Extended ${a.extensions}×` : 'Not triggered'],
    ['Opened', fmt.dateTime(a.startsAt)],
    [a.status === 'closed' ? 'Closed' : 'Scheduled close', fmt.dateTime(a.endsAt)],
  ];
  $('#kv').innerHTML = rows.map(([k, v]) => `<div><div class="label">${k}</div><div class="v">${esc(v)}</div></div>`).join('');
}

function renderResult(a) {
  const mine = me();
  const sold = a.outcome === 'SOLD';
  const youWon = sold && a.winner.bidder === mine;
  $('#resultSlot').innerHTML = `
    <div class="result-card ${sold ? 'sold' : 'unsold'}">
      <div class="ic">${sold ? ICONS.trophy : ICONS.clock}</div>
      <div>
        <b>${youWon ? 'You won this lot' : sold ? `Sold to ${esc(a.winner.bidder)}` : a.outcome === 'RESERVE_NOT_MET' ? 'Reserve not met' : 'Ended with no bids'}</b>
        <div class="small muted">${sold ? `Final price ${fmt.money(a.winner.amount)} · ${a.bidCount} bid${a.bidCount === 1 ? "" : "s"}` : a.outcome === 'RESERVE_NOT_MET' ? `Highest bid ${fmt.money(a.currentPrice)} didn't reach the reserve` : 'The lot may be relisted'}</div>
      </div>
    </div>`;
}

async function announceClose(a) {
  const mine = me();
  if (a.outcome === 'SOLD' && a.winner.bidder === mine) {
    confetti();
    await modal({ icon: ICONS.trophy, title: 'You won!', body: `${a.title} is yours for ${fmt.money(a.winner.amount)}.`, actions: [{ label: 'Nice!', value: 'ok', primary: true }] });
  } else if (a.outcome === 'SOLD') {
    await modal({ icon: ICONS.gavel, title: 'Sold!', body: `Won by ${a.winner.bidder} for ${fmt.money(a.winner.amount)}.`, actions: [{ label: 'Explore more lots', value: 'go', primary: true }, { label: 'Stay', value: 'stay' }] })
      .then((r) => r?.action === 'go' && (location.href = '/'));
  } else {
    await modal({ icon: ICONS.clock, title: a.outcome === 'RESERVE_NOT_MET' ? 'Reserve not met' : 'Auction ended', body: a.outcome === 'RESERVE_NOT_MET' ? `The highest bid of ${fmt.money(a.currentPrice)} didn't reach the seller's reserve.` : 'No bids were placed on this lot.' });
  }
}

function showExtension(a) {
  const slot = $('#extSlot');
  slot.innerHTML = `<div class="ext-banner">${ICONS.clock}<span>Late bid! The clock was extended by 30s (${a.extensions}× so far)</span></div>`;
  pulse($('#ring'), 'bump');
  clearTimeout(extTimer);
  extTimer = setTimeout(() => {
    const b = $('.ext-banner', slot);
    if (!b) return;
    b.classList.add('out');
    b.addEventListener('animationend', () => b.remove(), { once: true });
  }, 4000);
}

// ================================================================= history
function histItem(e) {
  const mine = me();
  const isMe = mine && e.bidder === mine;
  return el(`
    <li class="${isMe ? 'me' : ''}" data-seq="${e.seq}">
      ${avatar(e.bidder)}
      <div style="min-width:0">
        <div class="who">${isMe ? 'You' : esc(e.bidder)}${e.auto ? '<span class="tag auto">Auto</span>' : ''}${e.tie ? '<span class="tag tie">Tie: earlier bid wins</span>' : ''}<span class="tag leadtag" hidden>Leading</span></div>
        <div class="tiny faint" data-ago="${e.at}">${fmt.ago(e.at)}</div>
      </div>
      <div class="amt">${fmt.money(e.amount)}</div>
    </li>`);
}

function addHistory(entries, { fresh = false, animate = true } = {}) {
  const list = $('#hist');
  if (fresh) {
    list.innerHTML = '';
    lastSeq = 0;
  }
  const newOnes = entries.filter((e) => e.seq > lastSeq).sort((x, y) => x.seq - y.seq);
  for (const e of newOnes) {
    const li = histItem(e);
    if (animate && !fresh) li.classList.add('enter');
    list.prepend(li);
    lastSeq = e.seq;
  }
  while (list.children.length > 100) list.lastChild.remove();
  // Highlight the leading entry.
  [...list.children].forEach((li, i) => {
    const lead = i === 0 && A && (A.status !== 'closed' || A.outcome === 'SOLD');
    li.classList.toggle('lead', Boolean(lead));
    li.querySelector('.leadtag').hidden = !lead;
    if (lead && A.status === 'closed') li.querySelector('.leadtag').textContent = 'Winner';
  });
  $('#histEmpty').classList.toggle('hide', list.children.length > 0);
}

// ================================================================= bidding
$('#quick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  amountEl.value = b.dataset.v;
  amountDirty = true;
  pulse(amountEl, 'flash');
});
amountEl.addEventListener('input', () => {
  amountDirty = true;
  amountEl.classList.remove('invalid');
});
$('#inc').addEventListener('click', () => step(1));
$('#dec').addEventListener('click', () => step(-1));
function step(dir) {
  if (!A) return;
  const min = A.minNextBid ?? 0;
  amountEl.value = Math.max(min, (Number(amountEl.value) || min) + dir * A.minIncrement);
  amountDirty = true;
}
autoToggle.addEventListener('change', () => {
  $('#autoBox').classList.toggle('open', autoToggle.checked);
  if (autoToggle.checked && !maxEl.value && A) maxEl.value = (Number(amountEl.value) || A.minNextBid) + A.minIncrement * 5;
  if (autoToggle.checked) setTimeout(() => maxEl.focus(), 250);
});

$('#bidForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!A || A.status !== 'open') return;
  const name = await user.ensure();
  if (!name) return;

  const leading = A.leader === name;
  const auto = autoToggle.checked;
  let amount = leading ? A.currentPrice : Math.round(Number(amountEl.value));
  const maxAmount = auto ? Math.round(Number(maxEl.value)) : null;

  if (!leading && (!amount || amount < A.minNextBid)) {
    amountEl.classList.add('invalid');
    pulse(amountEl, 'shake');
    return toast('Bid too low', `Minimum is ${fmt.money(A.minNextBid)}`, 'bad');
  }
  if (auto && (!maxAmount || maxAmount < amount)) {
    pulse(maxEl, 'shake');
    return toast('Check your maximum', 'It must be at least your bid.', 'bad');
  }
  if (leading && !auto) return toast("You're already winning", 'Turn on auto-bid to raise your maximum.', 'info');

  const top = maxAmount ?? amount;
  if (!leading && top >= Math.max(priceOf(A) * 2, A.minNextBid + A.minIncrement * 20)) {
    const ok = await modal({
      icon: ICONS.alert,
      title: 'Big jump, are you sure?',
      body: `You're ${auto ? 'setting an auto-bid of' : 'bidding'} ${fmt.money(top)}, well above the current ${fmt.money(priceOf(A))}.`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Yes, place it', value: 'ok', primary: true }],
    });
    if (!ok) return;
  }

  const btn = $('#bidBtn');
  btn.classList.add('loading');
  const bidId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await api.post(`/auctions/${encodeURIComponent(id)}/bids`, { bidId, bidder: name, amount, maxAmount });
  btn.classList.remove('loading');

  if (r.status === 0) return toast('Network error', 'Your bid was not sent. Try again.', 'bad');
  const d = r.data;
  if (d.accepted) {
    if (auto) myMax.set(id, maxAmount);
    amountDirty = false;
    if (d.entries?.length) addHistory(d.entries);
    if (d.auction) applyAuction(d.auction, { extended: d.extended });
    if (d.outcome === 'LEADING') {
      toast("You're the highest bidder", `${fmt.money(d.auction.currentPrice)}${d.extended ? ' · clock +30s' : ''}`, 'ok');
      pulse($('.price-block'), 'flash');
    } else if (d.outcome === 'OUTBID') {
      toast('Outbid instantly', `Another bidder's auto-bid covered yours. Now ${fmt.money(d.auction.currentPrice)}.`, 'warn', 5000);
    } else if (d.outcome === 'MAX_RAISED') {
      toast('Auto-bid max raised', `We'll bid for you up to ${fmt.money(maxAmount)}.`, 'ok');
    }
  } else {
    if (d.reason === 'BID_TOO_LOW' && d.minAcceptable) {
      amountEl.value = d.minAcceptable;
      pulse(amountEl, 'flash');
    }
    if (d.auction) applyAuction(d.auction);
    toast('Bid not accepted', reasonText(d), 'bad');
  }
});

// ================================================================= actions
$('#watchBtn').addEventListener('click', () => {
  const on = watchlist.toggle(id);
  $('#watchBtn').classList.toggle('on', on);
  toast(on ? 'Added to your watchlist' : 'Removed from watchlist', '', on ? 'ok' : 'info', 2200);
});
$('#shareBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied', '', 'ok', 2000);
  } catch {
    toast('Copy this link', location.href, 'info');
  }
});
$('#verifyLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const r = await api.get(`/auctions/${encodeURIComponent(id)}/verify`);
  if (!r.ok) return toast('Could not verify', '', 'bad');
  await modal({
    icon: r.data.ok ? ICONS.shield : ICONS.alert,
    title: r.data.ok ? 'All checks passed' : 'Check failed',
    body: 'Recomputed by the server from the full bid history.',
    html: `<ul class="checks" style="text-align:left;margin-bottom:18px">${r.data.checks
      .map((c, i) => `<li style="--i:${i}"><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? ICONS.check : ICONS.x}</span><span class="name">${esc(c.name)}</span><span class="detail" title="${esc(c.detail)}">${esc(c.detail)}</span></li>`)
      .join('')}</ul>`,
  });
});

function notFound() {
  $('#detail').outerHTML = `<div class="empty glass"><span>${ICONS.search}</span><h3>Lot not found</h3><p class="muted">It may have been removed. <a href="/" style="color:var(--accent-2)">Browse live lots</a></p></div>`;
}

// ================================================================= live data
(async () => {
  if (!id) return;
  const r = await api.get(`/auctions/${encodeURIComponent(id)}`);
  if (r.status === 404) return notFound();
  if (r.ok && !A) {
    addHistory(r.data.history, { fresh: true });
    applyAuction(r.data.auction);
    addHistory([], {}); // refresh lead highlight now that A is set
  }
})();

const socket = getSocket();
const join = () => id && socket.emit('auction:join', id);
socket.on('connect', join);
if (socket.connected) join();
socket.on('auction:snapshot', ({ auction, history }) => {
  if (auction.id !== id) return;
  if (!A) {
    addHistory(history, { fresh: true });
    applyAuction(auction);
    addHistory([]);
  } else {
    addHistory(history); // fills any gap after a reconnect
    applyAuction(auction);
  }
});
socket.on('auction:update', ({ auction, entries, extended }) => {
  if (!A || auction.id !== id) return;
  addHistory(entries);
  applyAuction(auction, { extended });
});
socket.on('auction:closed', ({ auction }) => {
  if (!A || auction.id !== id) return;
  applyAuction(auction);
  addHistory([]);
});
socket.on('auction:error', () => notFound());

// ================================================================= ring
startTicker((now) => {
  if (!A) return;
  const ring = $('#ring');
  const bar = $('#ringBar');
  let frac = 0;
  let hot = false;
  if (A.status === 'scheduled') frac = 1;
  else if (A.status === 'open') {
    const left = Math.max(0, A.endsAt - now);
    hot = left <= 30_000;
    frac = hot ? left / 30_000 : left / Math.max(1, A.endsAt - A.startsAt);
  }
  bar.style.strokeDashoffset = String(RING * (1 - Math.min(1, frac)));
  ring.classList.toggle('hot', hot);
});
