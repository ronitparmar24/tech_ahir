import { $, $$, api, boot, startTicker, serverNow, fmt, pulse, el, cardHTML, user, toast, CATEGORIES, PALETTES } from './core.js';

boot('sell');

const form = {
  category: 'cameras',
  palette: 3,
  durationSeconds: 180,
  startsInSeconds: 0,
};

// ---------------------------------------------------------------- pickers
$('#catPick').innerHTML = Object.entries(CATEGORIES)
  .map(([k, c]) => `<button type="button" data-cat="${k}" class="${k === form.category ? 'active' : ''}">${c.icon}${c.label}</button>`)
  .join('');
$('#catPick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  $$('#catPick button').forEach((x) => x.classList.toggle('active', x === b));
  form.category = b.dataset.cat;
  preview();
});

$('#swatches').innerHTML = PALETTES.map(
  ([c1, c2, c3], i) => `<button type="button" class="swatch ${i === form.palette ? 'active' : ''}" data-p="${i}" style="--c1:${c1};--c2:${c2};--c3:${c3}" aria-label="Style ${i + 1}"></button>`,
).join('');
$('#swatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]');
  if (!b) return;
  $$('.swatch').forEach((x) => x.classList.toggle('active', x === b));
  form.palette = Number(b.dataset.p);
  preview();
});

function chipGroup(sel, key) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    $$(`${sel} .chip`).forEach((x) => x.classList.toggle('active', x === b));
    form[key] = Number(b.dataset.v);
    preview();
  });
}
chipGroup('#durationChips', 'durationSeconds');
chipGroup('#startChips', 'startsInSeconds');

$('#reserveToggle').addEventListener('change', (e) => {
  $('#reserveBox').classList.toggle('open', e.target.checked);
  if (e.target.checked && !$('#reservePrice').value) $('#reservePrice').value = Math.round(Number($('#startingPrice').value || 0) * 1.5) || '';
  preview();
});

$('#description').addEventListener('input', (e) => {
  $('#descCount').textContent = `${e.target.value.length} / 1000`;
});
for (const id of ['title', 'description', 'startingPrice', 'minIncrement', 'reservePrice']) {
  $(`#${id}`).addEventListener('input', () => {
    $(`#${id}`).classList.remove('invalid');
    const err = $(`[data-err="${id}"]`);
    if (err) err.textContent = '';
    preview();
  });
}

// ---------------------------------------------------------------- preview
function values() {
  const num = (id) => Math.round(Number($(`#${id}`).value));
  return {
    title: $('#title').value.trim(),
    description: $('#description').value.trim(),
    category: form.category,
    palette: form.palette,
    startingPrice: num('startingPrice'),
    minIncrement: num('minIncrement'),
    reservePrice: $('#reserveToggle').checked ? num('reservePrice') : null,
    durationSeconds: form.durationSeconds,
    startsInSeconds: form.startsInSeconds,
  };
}

function preview() {
  const v = values();
  const now = serverNow();
  const startsAt = now + v.startsInSeconds * 1000;
  const fake = {
    id: 'preview',
    title: v.title || 'Your item title',
    description: v.description,
    category: v.category,
    palette: v.palette,
    seller: user.name() || 'You',
    status: v.startsInSeconds ? 'scheduled' : 'open',
    startingPrice: v.startingPrice || 0,
    minIncrement: v.minIncrement || 0,
    currentPrice: null,
    bidCount: 0,
    watchers: 0,
    extensions: 0,
    startsAt,
    endsAt: startsAt + v.durationSeconds * 1000,
    createdAt: now,
  };
  const host = $('#preview');
  const first = !host.firstElementChild;
  host.innerHTML = '';
  const card = el(cardHTML(fake));
  if (!first) card.classList.remove('reveal');
  $('.art', card).style.viewTransitionName = 'none';
  // Nothing is published yet, so the preview shows the chosen duration as fixed text
  // instead of a live countdown that would run down while the form is being filled in.
  const cd = $('[data-countdown]', card);
  cd.removeAttribute('data-countdown');
  cd.textContent = fmt.left((v.startsInSeconds || v.durationSeconds) * 1000);
  $('[data-time-label]', card).textContent = v.startsInSeconds ? 'Starts in' : 'Runs for';
  host.append(card);
  updateSummary();
}

function updateSummary() {
  const v = values();
  const startsAt = serverNow() + v.startsInSeconds * 1000;
  const end = new Date(startsAt + v.durationSeconds * 1000);
  $('#timingSummary').textContent = `${v.startsInSeconds ? `Opens ${fmt.clock(startsAt)}` : 'Opens as soon as you publish'} · closes ~${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (+30s per late bid)`;
}
setInterval(updateSummary, 5000);

// ---------------------------------------------------------------- submit
function validate(v) {
  const errors = {};
  if (v.title.length < 3) errors.title = 'Give it a title (3+ characters)';
  if (!Number.isSafeInteger(v.startingPrice) || v.startingPrice < 1) errors.startingPrice = 'Whole number above 0';
  if (!Number.isSafeInteger(v.minIncrement) || v.minIncrement < 1) errors.minIncrement = 'Whole number above 0';
  if (v.reservePrice !== null && (!Number.isSafeInteger(v.reservePrice) || v.reservePrice < v.startingPrice)) {
    errors.reservePrice = 'Reserve must be at least the starting bid';
  }
  return errors;
}

$('#sellForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = values();
  const errors = validate(v);
  for (const [k, msg] of Object.entries(errors)) {
    $(`#${k}`).classList.add('invalid');
    $(`[data-err="${k}"]`).textContent = msg;
    pulse($(`#${k}`), 'shake');
  }
  if (Object.keys(errors).length) return toast('Check the highlighted fields', '', 'bad');

  const seller = await user.ensure();
  if (!seller) return;
  const btn = $('#publishBtn');
  btn.classList.add('loading');
  const r = await api.post('/auctions', { ...v, seller });
  btn.classList.remove('loading');
  if (!r.ok) return toast('Could not publish', r.data.error || 'Try again', 'bad');

  toast('Your lot is live', r.data.auction.title, 'ok');
  try {
    sessionStorage.setItem('lotline.peek', JSON.stringify({ id: r.data.auction.id, palette: r.data.auction.palette }));
  } catch {
    /* ignore */
  }
  setTimeout(() => (location.href = `/auction?id=${encodeURIComponent(r.data.auction.id)}`), 450);
});

preview();
startTicker();
