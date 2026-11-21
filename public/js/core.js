// Shared front-end core: API, live socket, server-clock sync, formatting,
// animations, toasts, modals, identity, watchlist, nav and the auction card.

/* global io */

// ------------------------------------------------------------------ icons
const svg = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

export const ICONS = {
  gavel: svg('<path d="m13 4 7 7-3 3-7-7z"/><path d="M13.5 10.5 4 20"/><path d="M14 21h7"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  heart: svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.8 1-1.1a5.5 5.5 0 0 0 0-7.5z"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  bolt: svg('<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-6"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  share: svg('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4M12 2v13"/>'),
  sparkle: svg('<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17v4M17 19h4"/>'),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  back: svg('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
  flame: svg('<path d="M12 22c4 0 7-2.7 7-6.5 0-3-2-5.2-3.5-6.5.2 2-1 3.5-2.5 3.5C14 9 12 5 9 2c.5 3.5-4 6-4 11.5C5 18 8 22 12 22z"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  server: svg('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
  tag: svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  pulse: svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  trophy: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  robot: svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 17h5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
  layers: svg('<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5M2 17l10 5 10-5"/>'),
  database: svg('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  play: svg('<path d="m6 4 14 8-14 8z"/>'),
};

export const CATEGORIES = {
  watches: { label: 'Watches', icon: svg('<circle cx="12" cy="12" r="6"/><path d="M12 9.5V12l1.8 1.3"/><path d="m9 6.5.6-4h4.8l.6 4M9 17.5l.6 4h4.8l.6-4"/>') },
  cameras: { label: 'Cameras', icon: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>') },
  art: { label: 'Art', icon: svg('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.4-9-7.4z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>') },
  sneakers: { label: 'Sneakers', icon: svg('<path d="M3 16.5V11l3-4 3 3.5c1.5 1.4 3.3 2 5.5 2.3l4.6.7A2 2 0 0 1 21 15.5v1H3z"/><path d="M3 19.5h18M9.5 12.5 11 11M12 13.5l1.3-1.6"/>') },
  collectibles: { label: 'Collectibles', icon: svg('<path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M12 21 9 9l3-6 3 6z"/>') },
  music: { label: 'Music', icon: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>') },
  tech: { label: 'Tech', icon: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>') },
};

export const PALETTES = [
  // [light, shadow, ink]: muted studio backdrops
  ['#ece8e1', '#d6cfc3', '#3d3a35'],
  ['#f0e2d8', '#d9b8a3', '#5a3a2a'],
  ['#e3e8df', '#bfcab6', '#33402f'],
  ['#e1e5ea', '#b7c0cb', '#2f3a46'],
  ['#f1e9d6', '#dccaa0', '#4d4128'],
  ['#dedcd8', '#b3b0aa', '#2a2a28'],
  ['#e7e6d6', '#c4c29d', '#3f3e27'],
  ['#efdfd6', '#cf9f88', '#4f2a1c'],
];

// ------------------------------------------------------------------ dom
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const params = new URLSearchParams(location.search);
export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ api
async function request(method, path, body) {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (data && typeof data.serverTime === 'number') noteServerTime(data.serverTime);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: 'Network error' } };
  }
}
export const api = { get: (p) => request('GET', p), post: (p, b) => request('POST', p, b || {}) };

// ------------------------------------------------------------------ server clock
// Countdowns use the SERVER's clock, not the device's. Offset is estimated
// NTP-style: serverTime + rtt/2 - localReceiveTime, keeping the lowest-RTT sample.
let clockOffset = 0;
let bestRtt = Infinity;
export const serverNow = () => Date.now() + clockOffset;
function noteServerTime() {} // offsets only come from timed samples below
export async function syncClock(samples = 4) {
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch('/api/time', { cache: 'no-store' });
      const { serverTime } = await res.json();
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (rtt <= bestRtt) {
        bestRtt = rtt;
        clockOffset = serverTime + rtt / 2 - t1;
      }
    } catch {
      /* offline: keep previous offset */
    }
  }
  return clockOffset;
}

// ------------------------------------------------------------------ format
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
export const fmt = {
  money: (n) => (n == null ? '—' : inr.format(n)),
  compact: (n) => compactFmt.format(n || 0),
  int: (n) => new Intl.NumberFormat('en-IN').format(n || 0),
  left(ms) {
    if (ms <= 0) return '0.0s';
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.floor(s)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  },
  ago(ts) {
    const s = Math.max(0, Math.round((serverNow() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
  clock: (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  dateTime: (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
};

// ------------------------------------------------------------------ animation helpers
const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Smoothly count a number element up/down to `to`. */
export function animateNumber(el, to, { format = fmt.money, duration = 800 } = {}) {
  if (!el) return;
  const from = Number(el.dataset.value ?? to);
  el.dataset.value = to;
  if (to == null || Number.isNaN(from) || from === to || prefersReducedMotion()) {
    el.textContent = format(to);
    return;
  }
  cancelAnimationFrame(el._raf);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(Math.round(from + (to - from) * easeOutExpo(t)));
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

/** Restart a one-shot CSS animation class. */
export function pulse(el, cls = 'bump') {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the animation restarts
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

/** FLIP: animate elements from their old positions to new ones after a reorder. */
export function flip(container, mutate) {
  const kids = [...container.children];
  const before = new Map(kids.map((k) => [k, k.getBoundingClientRect()]));
  mutate();
  if (prefersReducedMotion()) return;
  for (const k of container.children) {
    const a = before.get(k);
    if (!a) continue;
    const b = k.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) continue;
    k.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.22,1,.36,1)' });
  }
}

// ------------------------------------------------------------------ storage (best effort)
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode etc. */
    }
  },
};

/** Same rule as the server: 2–24 characters, at least one letter, no odd symbols. */
export function nameError(raw) {
  const v = String(raw ?? '').trim();
  if (v.length < 2) return 'Use at least 2 characters';
  if (v.length > 24) return 'Keep it under 24 characters';
  if (!/\p{L}/u.test(v)) return 'A name needs letters, not just numbers (e.g. riya_k)';
  if (!/^[\p{L}\p{N} ._-]+$/u.test(v)) return 'Letters, numbers, spaces, dots, dashes and underscores only';
  return '';
}

export const user = {
  // A saved name that breaks the rules (e.g. "1233" from before) is ignored, so the user is asked again.
  name: () => {
    const n = store.get('lotline.name', '');
    return typeof n === 'string' && !nameError(n) ? n : '';
  },
  set(name) {
    store.set('lotline.name', name);
    renderUserChip();
  },
  async ensure() {
    if (user.name()) return user.name();
    return user.prompt();
  },
  async prompt() {
    const result = await modal({
      icon: ICONS.user,
      title: user.name() ? 'Change your bidder name' : 'Pick a bidder name',
      body: 'Shown next to your bids. No sign-up needed for this demo.',
      input: { value: user.name(), placeholder: 'e.g. vintage_hunter', maxLength: 24 },
      html: '<p class="small faint" style="margin:-10px 0 14px">Use letters; numbers are fine alongside them.</p>',
      actions: [{ label: 'Cancel', value: null }, { label: 'Continue', value: 'ok', primary: true }],
      validate: nameError,
    });
    if (result?.action !== 'ok') return null;
    const name = result.value.trim();
    user.set(name);
    return name;
  },
};

export const watchlist = {
  all: () => store.get('lotline.watch', []),
  has: (id) => watchlist.all().includes(id),
  toggle(id) {
    const list = watchlist.all();
    const on = !list.includes(id);
    store.set('lotline.watch', on ? [...list, id] : list.filter((x) => x !== id));
    return on;
  },
};

export const myMax = {
  get: (id) => store.get(`lotline.max.${id}`, null),
  set: (id, v) => store.set(`lotline.max.${id}`, v),
};

// ------------------------------------------------------------------ socket
let socket = null;
export function getSocket() {
  if (socket) return socket;
  socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => setConn('on'));
  socket.on('disconnect', () => setConn('off'));
  socket.io.on('reconnect_attempt', () => setConn('wait'));
  return socket;
}
function setConn(state) {
  const el = $('#conn');
  if (!el) return;
  el.className = `conn ${state}`;
  $('span', el).textContent = state === 'on' ? 'Live' : state === 'off' ? 'Offline' : 'Reconnecting';
}

// ------------------------------------------------------------------ toasts
export function toast(title, body = '', type = 'info', ms = 3800) {
  let host = $('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const icon = { ok: ICONS.check, bad: ICONS.x, warn: ICONS.alert, info: ICONS.info }[type] || ICONS.info;
  const el = document.createElement('div');
  el.className = `toast glass glass-strong ${type}`;
  el.innerHTML = `<div class="ti">${icon}</div><div><b>${esc(title)}</b>${body ? `<p>${esc(body)}</p>` : ''}</div>`;
  host.prepend(el);
  while (host.children.length > 4) host.lastChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, ms);
}

// ------------------------------------------------------------------ modal
/**
 * @returns {Promise<{action: any, value: string}|null>}
 */
export function modal({ icon = ICONS.info, title, body = '', html = '', input = null, actions = [{ label: 'OK', value: 'ok', primary: true }], validate }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal glass glass-strong" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="big-icon">${icon}</div>
        <h2>${esc(title)}</h2>
        ${body ? `<p>${esc(body)}</p>` : ''}
        ${html}
        ${input ? `<input class="input" style="margin-bottom:6px" maxlength="${input.maxLength || 80}" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}">
          <div class="small" style="color:var(--hot);min-height:20px;margin-bottom:8px" data-err></div>` : ''}
        <div class="actions">${actions.map((a, i) => `<button class="btn ${a.primary ? 'btn-primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>
      </div>`;
    document.body.append(overlay);
    const field = $('input', overlay);
    const close = (action) => {
      if (action !== null && action !== undefined && field && validate) {
        const err = validate(field.value);
        if (err) {
          $('[data-err]', overlay).textContent = err;
          pulse(field, 'shake');
          return;
        }
      }
      overlay.classList.add('out');
      overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
      setTimeout(() => overlay.remove(), 400); // fallback: background tabs may skip animation events
      document.removeEventListener('keydown', onKey);
      resolve(action === null || action === undefined ? null : { action, value: field ? field.value : '' });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') {
        const primary = actions.find((a) => a.primary);
        if (primary) close(primary.value);
      }
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
      const b = e.target.closest('[data-i]');
      if (b) close(actions[Number(b.dataset.i)].value);
    });
    setTimeout(() => (field || $('.btn-primary', overlay) || $('.btn', overlay))?.focus(), 60);
  });
}

// ------------------------------------------------------------------ avatars
export function hue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export const initials = (name) =>
  String(name || '?')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || '?';
export const avatar = (name, cls = '') => `<span class="avatar ${cls}" style="--h:${hue(name)}">${esc(initials(name))}</span>`;

// ------------------------------------------------------------------ nav
const NAV = [
  { href: '/', key: 'explore', label: 'Explore', icon: ICONS.grid },
  { href: '/sell', key: 'sell', label: 'Sell', icon: ICONS.tag },
  { href: '/activity', key: 'activity', label: 'My bids', icon: ICONS.pulse },
  { href: '/system', key: 'system', label: 'System', icon: ICONS.server },
];

export function renderNav(active) {
  const header = document.createElement('header');
  header.className = 'topbar';
  header.innerHTML = `
    <div class="inner glass">
      <a class="brand" href="/"><span class="brand-mark">${ICONS.gavel}</span>Lotline</a>
      <nav class="nav-links" aria-label="Main">
        ${NAV.map((n) => `<a class="nav-link ${n.key === active ? 'active' : ''}" href="${n.href}">${n.icon}${n.label}</a>`).join('')}
      </nav>
      <div class="nav-right">
        <div class="conn wait" id="conn" title="Real-time connection"><i></i><span>Connecting</span></div>
        <button class="user-chip" id="userChip" type="button"></button>
      </div>
    </div>`;
  document.body.prepend(header);

  const tabbar = document.createElement('nav');
  tabbar.className = 'tabbar glass glass-strong';
  tabbar.setAttribute('aria-label', 'Main');
  tabbar.innerHTML = NAV.map((n) => `<a class="${n.key === active ? 'active' : ''}" href="${n.href}">${n.icon}<span>${n.label}</span></a>`).join('');
  document.body.append(tabbar);

  renderUserChip();
  $('#userChip').addEventListener('click', () => user.prompt());
}

function renderUserChip() {
  const chip = $('#userChip');
  if (!chip) return;
  const name = user.name();
  chip.innerHTML = name
    ? `${avatar(name, 'sm')}<span class="uname">${esc(name)}</span>`
    : `<span class="avatar sm" style="--h:220">${ICONS.user.replace('<svg', '<svg width="14" height="14"')}</span><span class="uname">Set name</span>`;
}

// ------------------------------------------------------------------ auction card
export function artStyle(a) {
  const [c1, c2, c3] = PALETTES[(a.palette ?? 0) % PALETTES.length];
  return `--c1:${c1};--c2:${c2};--c3:${c3}`;
}
export function artInner(a) {
  return `<span class="ring"></span><span class="ring"></span><span class="art-icon">${(CATEGORIES[a.category] || CATEGORIES.collectibles).icon}</span>`;
}

export function statusBadge(a) {
  if (a.status === 'open') return `<span class="badge live"><i></i>Live</span>`;
  if (a.status === 'scheduled') return `<span class="badge upcoming">${ICONS.calendar.replace('<svg', '<svg width="12" height="12"')}Upcoming</span>`;
  if (a.outcome === 'SOLD') return `<span class="badge sold">${ICONS.check.replace('<svg', '<svg width="12" height="12"')}Sold</span>`;
  return `<span class="badge ended">${a.outcome === 'RESERVE_NOT_MET' ? 'Reserve not met' : 'Ended'}</span>`;
}

export const priceLabel = (a) => (a.status === 'closed' ? (a.outcome === 'SOLD' ? 'Sold for' : 'Final bid') : a.currentPrice == null ? 'Starting bid' : 'Current bid');
export const timeLabel = (a) => (a.status === 'scheduled' ? 'Starts in' : a.status === 'closed' ? 'Ended' : 'Ends in');
export const priceOf = (a) => a.currentPrice ?? a.startingPrice;

export function countdownAttrs(a) {
  return `data-countdown data-ends="${a.endsAt}" data-starts="${a.startsAt}" data-status="${a.status}"`;
}

export function cardHTML(a, i = 0) {
  const cat = CATEGORIES[a.category] || CATEGORIES.collectibles;
  const watched = watchlist.has(a.id);
  return `
  <a class="card glass reveal ${a.status === 'closed' ? 'is-closed' : ''}" style="--i:${i}" href="/auction?id=${encodeURIComponent(a.id)}" data-id="${esc(a.id)}" data-palette="${a.palette ?? 0}">
    <div class="art" style="${artStyle(a)};view-transition-name:art-${esc(a.id)}">
      ${artInner(a)}
      <span data-badge>${statusBadge(a)}</span>
      <button class="icon-btn ${watched ? 'on' : ''}" type="button" data-watch="${esc(a.id)}" aria-label="Watch" aria-pressed="${watched}">${ICONS.heart}</button>
    </div>
    <div class="card-body">
      <div class="card-meta">${cat.label} · ${esc(a.seller)}</div>
      <h3 class="card-title">${esc(a.title)}</h3>
      <div class="card-row">
        <div>
          <div class="label" data-price-label>${priceLabel(a)}</div>
          <div class="price num" data-price data-value="${priceOf(a)}">${fmt.money(priceOf(a))}</div>
        </div>
        <div class="right">
          <div class="label" data-time-label>${timeLabel(a)}</div>
          <div class="countdown" ${countdownAttrs(a)}>—</div>
        </div>
      </div>
      <div class="card-foot">
        <span>${ICONS.gavel}<b data-bids>${a.bidCount}</b>&nbsp;bids</span>
        <span>${ICONS.eye}<b data-watchers>${a.watchers ?? 0}</b></span>
        <span class="ext" data-ext ${a.extensions ? '' : 'hidden'}>${ICONS.clock}+${a.extensions}×30s</span>
      </div>
    </div>
  </a>`;
}

/** Update a rendered card in place (keeps hover state, animates the price). */
export function patchCard(el, a, prev) {
  const priceEl = $('[data-price]', el);
  if (prev && priceOf(prev) !== priceOf(a)) {
    animateNumber(priceEl, priceOf(a));
    pulse(priceEl);
  } else {
    priceEl.textContent = fmt.money(priceOf(a));
    priceEl.dataset.value = priceOf(a);
  }
  $('[data-price-label]', el).textContent = priceLabel(a);
  $('[data-time-label]', el).textContent = timeLabel(a);
  const cd = $('[data-countdown]', el);
  cd.dataset.ends = a.endsAt;
  cd.dataset.starts = a.startsAt;
  cd.dataset.status = a.status;
  $('[data-bids]', el).textContent = a.bidCount;
  $('[data-watchers]', el).textContent = a.watchers ?? 0;
  const ext = $('[data-ext]', el);
  ext.hidden = !a.extensions;
  ext.innerHTML = `${ICONS.clock}+${a.extensions}×30s`;
  if (!prev || prev.status !== a.status || prev.outcome !== a.outcome) $('[data-badge]', el).innerHTML = statusBadge(a);
  el.classList.toggle('is-closed', a.status === 'closed');
  if (prev && prev.extensions !== a.extensions) pulse(ext, 'bump');
}

/** Heart buttons inside cards (delegated). */
export function bindWatchButtons(root = document) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-watch]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const on = watchlist.toggle(btn.dataset.watch);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    toast(on ? 'Added to your watchlist' : 'Removed from watchlist', '', on ? 'ok' : 'info', 2200);
  });
}

// ------------------------------------------------------------------ ticker
/** One timer drives every countdown and "x ago" on the page. */
export function startTicker(onTick) {
  const tick = () => {
    const now = serverNow();
    for (const el of $$('[data-countdown]')) {
      const status = el.dataset.status;
      let ms;
      if (status === 'closed') {
        el.textContent = fmt.ago(Number(el.dataset.ends));
        el.classList.remove('hot', 'urgent');
        el.closest('.card')?.classList.remove('is-hot');
        continue;
      }
      if (status === 'scheduled') ms = Number(el.dataset.starts) - now;
      else ms = Number(el.dataset.ends) - now;
      el.textContent = fmt.left(ms);
      const hot = status === 'open' && ms <= 30_000;
      el.classList.toggle('hot', hot);
      el.classList.toggle('urgent', status === 'open' && ms <= 10_000);
      el.closest('.card')?.classList.toggle('is-hot', hot);
    }
    for (const el of $$('[data-ago]')) el.textContent = fmt.ago(Number(el.dataset.ago));
    onTick?.(now);
  };
  tick();
  return setInterval(tick, 100);
}

/** Segmented control with a sliding indicator. */
export function segmented(el, onChange) {
  let indicator = $('.indicator', el);
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'indicator';
    el.prepend(indicator);
  }
  const move = () => {
    const active = $('button.active', el);
    if (!active) return;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translateX(${active.offsetLeft}px)`;
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.classList.contains('active')) return;
    $$('button', el).forEach((x) => x.classList.toggle('active', x === b));
    move();
    onChange?.(b.dataset.value);
  });
  new ResizeObserver(move).observe(el);
  requestAnimationFrame(move);
  return { move };
}

// ------------------------------------------------------------------ reasons
export function reasonText(r) {
  const map = {
    BID_TOO_LOW: `Bid too low${r.minAcceptable ? ` — minimum is ${fmt.money(r.minAcceptable)}` : ''}`,
    AUCTION_CLOSED: 'This auction has ended',
    NOT_STARTED: "This auction hasn't started yet",
    ALREADY_LEADING: "You're already the highest bidder. Raise your auto-bid max instead.",
    MAX_BELOW_AMOUNT: 'Your auto-bid max must be at least your bid',
    INVALID_AMOUNT: 'Enter a whole-number amount',
    INVALID_BIDDER: 'Pick a bidder name first',
    RATE_LIMITED: 'Too many bids — slow down a little',
    NOT_FOUND: 'Auction not found',
  };
  return map[r.reason] || r.error || 'Something went wrong';
}

// ------------------------------------------------------------------ confetti
export function confetti(duration = 2600) {
  if (prefersReducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:300';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#1c1b19', '#8a5a2b', '#cfa77a', '#2f6b45', '#d6cfc3'];
  const parts = Array.from({ length: 180 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200,
    y: innerHeight / 2.4,
    vx: (Math.random() - 0.5) * 16,
    vy: -Math.random() * 15 - 4,
    s: 5 + Math.random() * 7,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const frame = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.38;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / duration);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot
/**
 * "Simulated bidders" switch. The demo bots are server-wide, so flipping it here
 * updates every open page (the server broadcasts `demo:bots`).
 */
export function mountBotsToggle(host) {
  if (!host) return;
  host.innerHTML = `
    <div class="bots-row">
      <div>
        <div class="bots-title">${ICONS.robot}Simulated bidders</div>
        <div class="small faint" data-hint>Checking…</div>
      </div>
      <label class="switch" title="Turn the demo bidders on or off"><input type="checkbox" aria-label="Simulated bidders" disabled /><span class="track"></span></label>
    </div>`;
  const input = $('input', host);
  const hint = $('[data-hint]', host);
  const show = (on) => {
    input.checked = on;
    input.disabled = false;
    hint.textContent = on ? 'Bots are bidding against you. Turn off to bid alone and win.' : 'Off: only real people are bidding.';
  };
  api.get('/demo/bots').then((r) => r.ok && show(r.data.enabled));
  getSocket().on('demo:bots', ({ enabled }) => show(enabled));
  input.addEventListener('change', async () => {
    const want = input.checked;
    input.disabled = true;
    const r = await api.post('/demo/bots', { enabled: want });
    if (!r.ok) {
      show(!want);
      return toast('Could not change it', r.data.error || 'Try again', 'bad');
    }
    show(r.data.enabled);
    toast(r.data.enabled ? 'Simulated bidders on' : 'Simulated bidders off', r.data.enabled ? 'Expect competition.' : 'Nobody will outbid you now.', 'info', 2600);
  });
}

/** Replace <span data-icon="name"> placeholders in static HTML with SVG icons. */
export function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root)) if (!el.firstChild) el.innerHTML = ICONS[el.dataset.icon] || '';
}

/** Turn an HTML string into one element. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Drop the entrance-animation class once it has played, so re-ordering never replays it. */
export function settle(node) {
  node.addEventListener('animationend', function done(e) {
    if (e.target !== node || e.animationName !== 'rise') return;
    node.classList.remove('reveal');
    node.removeEventListener('animationend', done);
  });
}

export function boot(active) {
  renderNav(active);
  hydrateIcons();
  // Entrance animations run once; removing the class afterwards stops replays on re-order
  // and leaves no transform/opacity behind that could interfere with nested glass blur.
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'rise' && e.target.classList?.contains('reveal')) e.target.classList.remove('reveal');
  });
  // Remember the clicked lot's look so its page can paint matching art before data arrives.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-id][data-palette]');
    if (!link) return;
    try {
      sessionStorage.setItem('lotline.peek', JSON.stringify({ id: link.dataset.id, palette: Number(link.dataset.palette) }));
    } catch {
      /* ignore */
    }
  }, true);
  syncClock();
  setInterval(() => syncClock(2), 60_000);
  getSocket();
}
