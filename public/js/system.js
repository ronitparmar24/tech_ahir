import { $, $$, api, boot, getSocket, fmt, animateNumber, esc, toast, ICONS, pulse, mountBotsToggle } from './core.js';

boot('system');
mountBotsToggle($('#botsSlot'));

const int = { format: fmt.int, duration: 500 };
let count = 300;

function uptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderStats(s) {
  animateNumber($('#kBps'), s.bidsPerSecond, int);
  $('#kBpm').textContent = `${fmt.int(s.bidsLastMinute)} in the last minute`;
  $('#kP50').textContent = `${s.latencyMicros.p50}µs`;
  $('#kP99').textContent = `median · p99 ${s.latencyMicros.p99}µs`;
  animateNumber($('#kSockets'), s.sockets, int);
  $('#kMem').textContent = `${s.memoryMB} MB memory`;
  animateNumber($('#kOpen'), s.auctions.open, int);
  $('#kAuctions').textContent = `live · ${s.auctions.scheduled} upcoming · ${s.auctions.closed} closed`;
  if (s.eventsPersisted == null) {
    $('#kEvents').textContent = 'off';
    $('#kRestored').textContent = 'memory-only mode';
  } else {
    animateNumber($('#kEvents'), s.eventsPersisted, int);
    $('#kRestored').textContent = s.restored?.replayed ? `${fmt.int(s.restored.replayed)} replayed on start-up` : 'durable command log';
  }
  $('#kUptime').textContent = uptime(s.uptimeMs);
  $('#kTotals').textContent = `${fmt.int(s.totals.accepted)} accepted · ${fmt.int(s.totals.rejected)} rejected`;
  $('#extTotal').textContent = `${fmt.int(s.totals.extensions)} anti-snipe extensions`;
  drawSpark(s.series);
}

function drawSpark(series) {
  const W = 600;
  const H = 160;
  const max = Math.max(5, ...series);
  const step = W / (series.length - 1);
  const pts = series.map((v, i) => [i * step, H - 8 - (v / max) * (H - 24)]);
  // Smooth curve through the points (Catmull-Rom → Bézier).
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  $('#spark .line').setAttribute('d', d);
  $('#spark .area').setAttribute('d', `${d} L${W},${H} L0,${H} Z`);
  $('#sparkMax').textContent = `peak ${Math.max(...series)}/s`;
}

// ---------------------------------------------------------------- stress test
async function loadTargets() {
  const r = await api.get('/auctions?status=live&sort=bids');
  const sel = $('#target');
  const prev = sel.value;
  sel.innerHTML = r.ok && r.data.auctions.length
    ? r.data.auctions.map((a) => `<option value="${esc(a.id)}">${esc(a.title)}: ${fmt.money(a.currentPrice ?? a.startingPrice)}</option>`).join('')
    : '<option value="">No live lots: list one on the Sell page</option>';
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

$('#counts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  $$('#counts .chip').forEach((x) => x.classList.toggle('active', x === b));
  count = Number(b.dataset.v);
});

$('#run').addEventListener('click', async () => {
  const id = $('#target').value;
  if (!id) return toast('No live lot to test', 'Create one on the Sell page first.', 'warn');
  const btn = $('#run');
  btn.classList.add('loading');
  const r = await api.post(`/auctions/${encodeURIComponent(id)}/stress`, { count });
  btn.classList.remove('loading');
  if (!r.ok) return toast('Stress test failed', r.data.reason || r.data.error || 'Try another lot', 'bad');
  const d = r.data;
  $('#stressOut').innerHTML = `
    <div class="stress-result">
      <div><b>${fmt.int(d.sent)}</b><span>sent in ${d.ms}ms</span></div>
      <div><b style="color:var(--ok)">${fmt.int(d.leading)}</b><span>took the lead</span></div>
      <div><b style="color:var(--warn)">${fmt.int(d.outbid)}</b><span>outbid by auto-bid</span></div>
      <div><b style="color:var(--faint)">${fmt.int(d.rejected)}</b><span>rejected (too low)</span></div>
    </div>
    <div class="pill ${d.highestWon ? 'ok' : 'bad'}" style="margin-top:12px">${d.highestWon ? ICONS.check : ICONS.x}
      Highest bid sent ${fmt.money(d.highestSent)} → final price ${fmt.money(d.finalPrice)}</div>
    <ul class="checks">${d.verify.checks
      .map((c, i) => `<li style="--i:${i}"><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? ICONS.check : ICONS.x}</span><span class="name">${esc(c.name)}</span><span class="detail" title="${esc(c.detail)}">${esc(c.detail)}</span></li>`)
      .join('')}</ul>`;
  pulse($('#stressOut'), 'flash');
  toast(d.verify.ok && d.highestWon ? 'All invariants hold' : 'Invariant violated!', `${d.sent} bids in ${d.ms}ms`, d.verify.ok ? 'ok' : 'bad');
  loadTargets();
});

// ---------------------------------------------------------------- live
const socket = getSocket();
const join = () => socket.emit('stats:join');
socket.on('connect', join);
if (socket.connected) join();
socket.on('stats', renderStats);

api.get('/stats').then((r) => r.ok && renderStats(r.data));
loadTargets();
setInterval(loadTargets, 15_000);

// ---------------------------------------------------------------- database
const seenRows = new Set();
async function loadDb() {
  const r = await api.get('/db');
  if (!r.ok) return;
  const d = r.data;
  if (!d.enabled) {
    $('#dbEngine').textContent = 'Database disabled (memory-only mode)';
    $('#dbRows').innerHTML = '<tr><td colspan="6" class="faint">Start the server normally to store data in SQLite.</td></tr>';
    return;
  }
  $('#dbEngine').textContent = d.engine;
  $('#dbFile').textContent = `${d.file}${d.sizeKB != null ? ` · ${fmt.int(d.sizeKB)} KB` : ''}`;
  animateNumber($('#dbAuctions'), d.auctions, int);
  animateNumber($('#dbBids'), d.bids, int);
  animateNumber($('#dbUsers'), d.users, int);
  animateNumber($('#dbCommands'), d.commands, int);
  const first = seenRows.size === 0;
  $('#dbRows').innerHTML = d.recentBids.length
    ? d.recentBids
        .map((b) => {
          const key = `${b.auction_id}#${b.seq}`;
          const fresh = !first && !seenRows.has(key);
          seenRows.add(key);
          return `<tr class="${fresh ? 'enter' : ''}"><td title="${esc(b.auction_id)}">${esc(b.title)}</td><td class="r">${b.seq}</td><td>${esc(b.bidder)}</td>
            <td class="r">${fmt.money(b.amount)}</td><td>${b.auto ? 'auto-bid' : 'bid'}</td><td class="r faint">${fmt.ago(b.at)}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="faint">No bids stored yet.</td></tr>';
}
loadDb();
setInterval(loadDb, 2000);
