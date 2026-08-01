// Dashboard wiring: current conditions, the range filter, four charts and the
// table view. Everything below the filter row renders against the same slice.

import { loadIndex, loadDaily, loadLatest, loadRange } from './data.js';
import { lineChart, barChart, legend } from './charts.js';

const SERIES_1 = 'var(--series-1)';
const SERIES_2 = 'var(--series-2)';

// ─────────────────────────── formatting ───────────────────────────

const has = (v) => typeof v === 'number' && Number.isFinite(v);
const fixed = (v, digits) => (has(v) ? v.toFixed(digits) : '—');

const degF = (v) => (has(v) ? `${v.toFixed(1)}°F` : '—');
const mph = (v) => (has(v) ? `${v.toFixed(1)} mph` : '—');
const inches = (v) => (has(v) ? `${v.toFixed(2)}"` : '—');
const inHg = (v) => (has(v) ? `${v.toFixed(2)} inHg` : '—');
const percent = (v) => (has(v) ? `${Math.round(v)}%` : '—');

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => (has(deg) ? COMPASS[Math.round(deg / 22.5) % 16] : '—');

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

const DAY_MS = 86400000;

/**
 * Axis labels follow the span, not the resolution: clock times read well across
 * a day and turn to noise across a week, where the reader wants the date.
 * The tooltip (`full`) always carries the whole timestamp.
 */
function axisFormatter(mode, spanMs) {
  if (mode !== 'hires') return (x, full) => (full ? dateFmt.format(x) : dayFmt.format(x));
  if (spanMs > 1.5 * DAY_MS) return (x, full) => (full ? fullFmt.format(x) : dayFmt.format(x));
  return (x, full) => (full ? fullFmt.format(x) : timeFmt.format(x));
}

// ─────────────────────────── theme ───────────────────────────

function initTheme() {
  const button = document.getElementById('theme-toggle');
  const stored = localStorage.getItem('wx-theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);

  const dark = () => (document.documentElement.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const sync = () => { button.textContent = dark() ? 'Light' : 'Dark'; };

  button.addEventListener('click', () => {
    const next = dark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('wx-theme', next);
    sync();
  });
  sync();
}

// ─────────────────────────── current conditions ───────────────────────────

function tile(label, value, sub) {
  const node = document.createElement('div');
  const l = document.createElement('div');
  l.className = 'tile-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'tile-value';
  v.textContent = value;
  node.append(l, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'tile-sub';
    s.textContent = sub;
    node.append(s);
  }
  return node;
}

function renderNow(latest) {
  const tiles = document.getElementById('tiles');
  tiles.replaceChildren();
  const obs = latest?.observation;
  if (!obs) return;

  document.getElementById('hero-temp').textContent = has(obs.tempF) ? `${obs.tempF.toFixed(1)}°` : '—';
  const when = obs.local || obs.ts;
  document.getElementById('hero-time').textContent = when
    ? `as of ${fullFmt.format(new Date(obs.epoch * 1000))}`
    : 'no observations yet';

  // "Feels like" is heat index above room temperature, wind chill below it.
  const feels = has(obs.tempF) && obs.tempF >= 70 ? obs.heatIndexF : obs.windChillF;
  const today = latest.today;

  tiles.append(
    tile('Feels like', degF(has(feels) ? feels : obs.tempF)),
    tile('Dew point', degF(obs.dewptF)),
    tile('Humidity', percent(obs.humidity)),
    tile('Wind', mph(obs.windMph), `from ${compass(obs.windDir)}`),
    tile('Gust', mph(obs.gustMph), has(today?.gustMax) ? `${fixed(today.gustMax, 1)} today` : null),
    tile('Pressure', inHg(obs.pressureIn)),
    tile('Rain today', inches(obs.precipTotalIn),
      has(obs.precipRateIn) && obs.precipRateIn > 0 ? `${fixed(obs.precipRateIn, 2)} in/hr now` : null),
  );

  if (has(obs.solarWm2) || has(obs.uv)) {
    tiles.append(tile('Solar', has(obs.solarWm2) ? `${Math.round(obs.solarWm2)} W/m²` : '—',
      has(obs.uv) ? `UV ${obs.uv}` : null));
  }
  if (has(today?.tempMax) && has(today?.tempMin)) {
    tiles.append(tile('Today', `${fixed(today.tempMax, 0)}° / ${fixed(today.tempMin, 0)}°`, 'high / low'));
  }
}

// ─────────────────────────── charts ───────────────────────────

function slots(id) {
  const chart = document.getElementById(id);
  let slot = chart.previousElementSibling;
  if (!slot || !slot.classList.contains('legend-slot')) {
    slot = document.createElement('div');
    slot.className = 'legend-slot';
    chart.before(slot);
  }
  return { chart, slot };
}

/**
 * Rain between consecutive samples, summed into hour or day buckets.
 * precipTotal is a daily accumulator, so the increment is the difference —
 * a decrease means the midnight reset, which contributes nothing.
 */
function precipBuckets(points, unit) {
  const buckets = new Map();
  let previous = null;
  for (const point of points) {
    if (!has(point.precipTotalIn)) continue;
    if (previous !== null && point.precipTotalIn >= previous) {
      const start = new Date(point.x);
      if (unit === 'day') start.setHours(0, 0, 0, 0);
      else start.setMinutes(0, 0, 0);
      const key = start.getTime();
      buckets.set(key, (buckets.get(key) || 0) + (point.precipTotalIn - previous));
    }
    previous = point.precipTotalIn;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, v]) => ({ x, v }));
}

function renderCharts(slice) {
  const hires = slice.mode === 'hires';
  const points = slice.points;
  const span = points.length > 1 ? points[points.length - 1].x - points[0].x : 0;
  const xFormat = axisFormatter(slice.mode, span);

  // Compact end labels — the card subtitle already states the unit.
  const endF = (v) => (has(v) ? `${v.toFixed(1)}°` : '');
  const endPlain = (v) => (has(v) ? v.toFixed(1) : '');
  const endHg = (v) => (has(v) ? v.toFixed(2) : '');

  // ── temperature
  const temp = slots('chart-temp');
  if (hires) {
    const series = [
      { key: 'tempF', name: 'Temperature', color: SERIES_1 },
      { key: 'dewptF', name: 'Dew point', color: SERIES_2 },
    ];
    document.getElementById('temp-sub').textContent = '°F — temperature and dew point';
    legend(temp.slot, series);
    lineChart(temp.chart, {
      points, series, format: degF, formatEnd: endF, formatTick: (v) => v.toFixed(0), xFormat,
      ariaLabel: 'Temperature and dew point over time',
    });
  } else {
    const series = [{ key: 'tempAvg', name: 'Daily average', color: SERIES_1 }];
    document.getElementById('temp-sub').textContent = '°F — daily high/low range, average line';
    legend(temp.slot, series);                     // single series: no legend box
    lineChart(temp.chart, {
      points, series,
      band: { lowKey: 'tempMin', highKey: 'tempMax', color: SERIES_1 },
      format: degF, formatEnd: endF, formatTick: (v) => v.toFixed(0), xFormat,
      ariaLabel: 'Daily temperature range and average',
    });
  }

  // ── wind
  const wind = slots('chart-wind');
  const windSeries = hires
    ? [{ key: 'windMph', name: 'Sustained', color: SERIES_1 },
       { key: 'gustMph', name: 'Gust', color: SERIES_2 }]
    : [{ key: 'windAvg', name: 'Average', color: SERIES_1 },
       { key: 'gustMax', name: 'Peak gust', color: SERIES_2 }];
  legend(wind.slot, windSeries);
  lineChart(wind.chart, {
    points, series: windSeries, format: mph, formatEnd: endPlain,
    formatTick: (v) => v.toFixed(0), xFormat,
    ariaLabel: 'Wind speed over time',
  });

  // ── precipitation
  // Hourly bars only make sense over a day or so; past that they collapse into
  // hairlines, so the buckets widen to match the span.
  const precip = slots('chart-precip');
  const byHour = hires && span <= 1.5 * DAY_MS;
  const precipPoints = hires
    ? precipBuckets(points, byHour ? 'hour' : 'day')
    : points.map((p) => ({ x: p.x, v: has(p.precipIn) ? p.precipIn : 0 }));
  document.getElementById('precip-sub').textContent = byHour ? 'inches per hour' : 'inches per day';
  legend(precip.slot, []);
  barChart(precip.chart, {
    points: precipPoints, color: SERIES_1, name: byHour ? 'Rain this hour' : 'Rain',
    format: inches, formatTick: (v) => v.toFixed(2), xFormat,
    emptyMessage: 'No rain recorded in this range.',
    ariaLabel: 'Precipitation',
  });

  // ── pressure
  const pressure = slots('chart-pressure');
  if (hires) {
    const series = [{ key: 'pressureIn', name: 'Pressure', color: SERIES_1 }];
    legend(pressure.slot, series);
    lineChart(pressure.chart, {
      points, series, format: inHg, formatEnd: endHg, formatTick: (v) => v.toFixed(2), xFormat,
      ariaLabel: 'Barometric pressure over time',
    });
  } else {
    const withMid = points.map((p) => ({
      ...p,
      pressureMid: has(p.pressureMin) && has(p.pressureMax)
        ? (p.pressureMin + p.pressureMax) / 2
        : null,
    }));
    const series = [{ key: 'pressureMid', name: 'Daily midpoint', color: SERIES_1 }];
    legend(pressure.slot, series);
    lineChart(pressure.chart, {
      points: withMid, series,
      band: { lowKey: 'pressureMin', highKey: 'pressureMax', color: SERIES_1 },
      format: inHg, formatEnd: endHg, formatTick: (v) => v.toFixed(2), xFormat,
      ariaLabel: 'Daily barometric pressure range',
    });
  }
}

// ─────────────────────────── table view ───────────────────────────

const HIRES_COLUMNS = [
  ['Time', (p) => fullFmt.format(p.x)],
  ['Temp °F', (p) => fixed(p.tempF, 1)],
  ['Dew pt °F', (p) => fixed(p.dewptF, 1)],
  ['Humidity %', (p) => fixed(p.humidity, 0)],
  ['Wind mph', (p) => fixed(p.windMph, 1)],
  ['Gust mph', (p) => fixed(p.gustMph, 1)],
  ['Dir', (p) => compass(p.windDir)],
  ['Pressure inHg', (p) => fixed(p.pressureIn, 2)],
  ['Rain in', (p) => fixed(p.precipTotalIn, 2)],
];

const DAILY_COLUMNS = [
  ['Date', (p) => p.date],
  ['High °F', (p) => fixed(p.tempMax, 1)],
  ['Low °F', (p) => fixed(p.tempMin, 1)],
  ['Avg °F', (p) => fixed(p.tempAvg, 1)],
  ['Dew pt °F', (p) => fixed(p.dewptAvg, 1)],
  ['Humidity %', (p) => fixed(p.humidityAvg, 0)],
  ['Wind mph', (p) => fixed(p.windAvg, 1)],
  ['Gust mph', (p) => fixed(p.gustMax, 1)],
  ['Rain in', (p) => fixed(p.precipIn, 2)],
];

const MAX_ROWS = 400;

function renderTable(slice) {
  const table = document.getElementById('data-table');
  const columns = slice.mode === 'hires' ? HIRES_COLUMNS : DAILY_COLUMNS;

  // Every value on screen is in here; long ranges are evenly sampled so the
  // table stays usable rather than shipping 26,000 rows.
  const stride = Math.max(1, Math.ceil(slice.points.length / MAX_ROWS));
  const rows = slice.points.filter((_, i) => i % stride === 0);

  const caption = document.getElementById('table-caption');
  caption.textContent = stride > 1
    ? `${rows.length} of ${slice.points.length} observations (every ${stride}th).`
    : `${rows.length} observation${rows.length === 1 ? '' : 's'}.`;

  const head = document.createElement('tr');
  for (const [label] of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    head.append(th);
  }
  table.tHead.replaceChildren(head);

  const body = document.createDocumentFragment();
  for (const point of rows) {
    const tr = document.createElement('tr');
    for (const [, read] of columns) {
      const td = document.createElement('td');
      td.textContent = read(point);
      tr.append(td);
    }
    body.append(tr);
  }
  table.tBodies[0].replaceChildren(body);
}

// ─────────────────────────── boot ───────────────────────────

async function main() {
  initTheme();

  const [index, daily, latest] = await Promise.all([loadIndex(), loadDaily(), loadLatest()]);

  const station = latest?.station || index.station;
  if (station) {
    document.getElementById('station-id').textContent = station;
    document.getElementById('wu-link').href = `https://www.wunderground.com/dashboard/pws/${station}`;
  }
  const meta = latest?.meta;
  if (meta?.neighborhood) {
    document.getElementById('station-name').textContent = meta.neighborhood;
    document.title = `${meta.neighborhood} — Station Dashboard`;
  }

  renderNow(latest);

  const note = document.getElementById('range-note');
  if (!index.days.length) {
    note.textContent = 'No archived observations yet — run weather/tools/archive.mjs.';
  } else {
    note.textContent = `${index.days.length} day${index.days.length === 1 ? '' : 's'} archived, `
      + `${index.firstDate} → ${index.lastDate}`;
  }

  const charts = document.getElementById('charts');
  let token = 0;

  async function show(rangeDays) {
    const mine = ++token;
    charts.classList.add('loading');
    const slice = await loadRange(rangeDays, index, daily);
    if (mine !== token) return;               // a newer range won the race
    renderCharts(slice);
    renderTable(slice);
    charts.classList.remove('loading');
  }

  for (const button of document.querySelectorAll('.range-btn')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.range-btn')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      show(Number(button.dataset.range));
    });
  }

  await show(1);
}

main().catch((err) => {
  console.error(err);
  document.getElementById('range-note').textContent = `Failed to load: ${err.message}`;
});
