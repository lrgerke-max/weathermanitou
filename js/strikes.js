/*
 * The permanent lightning panel: the five most recent strikes inside the camp
 * radius, each with how long ago it hit and how far away it was.
 *
 * Archived strikes already carry distanceMi and bearingDeg, but those are
 * measured from the weather station at archive time. If the reference point is
 * moved (see CAMP in app.js), those numbers would silently be wrong, so this
 * recomputes from the strike's own coordinates whenever it has them and only
 * falls back to the archived figures for a bare detector, which reports a
 * distance and no position at all.
 */

const MI_PER_KM = 0.621371;
const EARTH_KM = 6371;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const rad = (d) => (d * Math.PI) / 180;

export function haversineMi(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a))) * MI_PER_KM;
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2))
    - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const compass = (deg) =>
  (typeof deg === 'number' && Number.isFinite(deg) ? COMPASS[Math.round(deg / 22.5) % 16] : null);

/**
 * "4 min ago" beats a clock time on a wall display — nobody standing in the
 * office should have to do subtraction to find out how close a storm is.
 */
function ago(seconds) {
  if (seconds < 45) return 'just now';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h} h ${rem} m ago` : `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Distance band → brand ramp slot, nearest strike the most urgent colour. */
function bandVar(miles) {
  if (miles < 5) return '--strike-1';
  if (miles < 10) return '--strike-2';
  if (miles < 15) return '--strike-3';
  if (miles < 20) return '--strike-4';
  return '--strike-5';
}

function triangle(colorVar) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'strike-tri');
  svg.setAttribute('viewBox', '0 0 15 13');
  svg.setAttribute('aria-hidden', 'true');
  const tri = document.createElementNS(ns, 'path');
  // Inverted triangle — the Y graphic element, used here as a pointer (p26).
  tri.setAttribute('d', 'M0.9 1.2 H14.1 L7.5 12.1 Z');
  tri.setAttribute('fill', `var(${colorVar})`);
  svg.appendChild(tri);
  return svg;
}

/**
 * Normalise, filter to the radius and take the newest few.
 * Exported so it can be unit-tested without a DOM.
 */
export function recentStrikes(strikes, ref, radiusMi, limit) {
  const out = [];
  for (const s of strikes || []) {
    if (!s || typeof s.epoch !== 'number') continue;

    let miles = null;
    let bearing = null;
    if (typeof s.lat === 'number' && typeof s.lon === 'number') {
      miles = haversineMi(ref.lat, ref.lon, s.lat, s.lon);
      bearing = bearingDeg(ref.lat, ref.lon, s.lat, s.lon);
    } else if (typeof s.distanceMi === 'number') {
      miles = s.distanceMi;
      bearing = typeof s.bearingDeg === 'number' ? s.bearingDeg : null;
    }
    if (miles === null || miles > radiusMi) continue;

    out.push({ epoch: s.epoch, miles, bearing, type: s.type || null });
  }
  out.sort((a, b) => b.epoch - a.epoch);
  return out.slice(0, limit);
}

// ─────────────────────────── rendering ───────────────────────────

let ticker = null;
let state = null;

export function renderStrikes(strikes, ref, { radiusMi = 25, limit = 5, configured = true } = {}) {
  state = { strikes, ref, radiusMi, limit, configured };
  paint();

  // Ages must stay honest on a screen nobody ever reloads by hand.
  clearInterval(ticker);
  ticker = setInterval(paint, 30_000);
}

function paint() {
  if (!state) return;
  const { strikes, ref, radiusMi, limit, configured } = state;

  const list = document.getElementById('strike-list');
  const summary = document.getElementById('strike-summary');
  const countEl = document.getElementById('strike-count');
  const labelEl = document.getElementById('strike-count-label');
  const sub = document.getElementById('strike-sub');
  if (!list) return;

  if (sub) sub.textContent = `within ${radiusMi} mi`;
  list.textContent = '';

  if (!configured) {
    if (summary) summary.hidden = true;
    const box = document.createElement('div');
    box.className = 'strike-empty';
    box.append(
      Object.assign(document.createElement('span'), { textContent: 'Lightning detection is not configured.' }),
      Object.assign(document.createElement('span'), {
        className: 'fact-sub',
        textContent: 'Set XWEATHER_CLIENT_ID and XWEATHER_CLIENT_SECRET, then run tools/lightning-archive.mjs.',
      }),
    );
    list.appendChild(box);
    return;
  }

  const rows = recentStrikes(strikes, ref, radiusMi, limit);
  const now = Date.now() / 1000;

  // Big number = strikes in the last hour, which is the number that decides
  // whether the waterfront stays open.
  const lastHour = (strikes || []).filter((s) => {
    if (!s || typeof s.epoch !== 'number' || now - s.epoch > 3600) return false;
    const m = (typeof s.lat === 'number' && typeof s.lon === 'number')
      ? haversineMi(ref.lat, ref.lon, s.lat, s.lon)
      : s.distanceMi;
    return typeof m === 'number' && m <= radiusMi;
  }).length;

  if (summary && countEl && labelEl) {
    summary.hidden = false;
    countEl.textContent = String(lastHour);
    countEl.classList.toggle('none', lastHour === 0);
    labelEl.textContent = lastHour === 1
      ? 'strike in the\nlast hour'
      : 'strikes in the\nlast hour';
    labelEl.style.whiteSpace = 'pre-line';
  }

  if (!rows.length) {
    const box = document.createElement('div');
    box.className = 'strike-empty';
    const big = document.createElement('span');
    big.className = 'big';
    big.textContent = 'All clear';
    const detail = document.createElement('span');
    detail.textContent = `No strikes recorded within ${radiusMi} miles of camp.`;
    box.append(big, detail);
    list.appendChild(box);
    return;
  }

  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'strike-row';

    li.appendChild(triangle(bandVar(row.miles)));

    const when = document.createElement('div');
    const w1 = document.createElement('div');
    w1.className = 'strike-when';
    w1.textContent = ago(now - row.epoch);
    const w2 = document.createElement('div');
    w2.className = 'strike-abs';
    const parts = [clockFmt.format(new Date(row.epoch * 1000))];
    // Cloud-to-ground is the kind that hits something; worth calling out.
    if (row.type === 'CG') parts.push('cloud-to-ground');
    w2.textContent = parts.join(' · ');
    when.append(w1, w2);
    li.appendChild(when);

    const dist = document.createElement('div');
    const d1 = document.createElement('div');
    d1.className = 'strike-dist';
    d1.textContent = `${row.miles.toFixed(1)} mi`;
    const d2 = document.createElement('div');
    d2.className = 'strike-bear';
    const c = compass(row.bearing);
    d2.textContent = c ? `to the ${c}` : '';
    dist.append(d1, d2);
    li.appendChild(dist);

    list.appendChild(li);
  }
}
