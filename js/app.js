// Dashboard wiring.
//
// Layout contract: everything above the filter row describes *now* (current
// reading, today's range, a 24-hour sparkline). Everything below it — charts,
// extremes, table — renders against the selected range, so those numbers always
// agree with each other.

import { loadIndex, loadDaily, loadLatest, loadRange } from './data.js';
import { lineChart, barChart, windRose, sparkline, legend } from './charts.js';
import { sunTimes } from './sun.js';

const SERIES_1 = 'var(--series-1)';
const SERIES_2 = 'var(--series-2)';
const SERIES_3 = 'var(--series-3)';

// Wind-rose speed bins. Edges must match ROSE_EDGES in weather/tools/store.mjs,
// which pre-computes the same bins into the daily rollups.
const WIND_BINS = [
  { label: '0–5 mph', color: 'var(--bin-1)' },
  { label: '5–10', color: 'var(--bin-2)' },
  { label: '10–20', color: 'var(--bin-3)' },
  { label: '20–30', color: 'var(--bin-4)' },
  { label: '30+', color: 'var(--bin-5)' },
];
const WIND_EDGES = [5, 10, 20, 30];
const CALM_MPH = 1;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const DAY_MS = 86400000;

// Keeps an empty label line occupying its row so cells stay aligned.
const NBSP = '\u00a0';

// ─────────────────────────── formatting ───────────────────────────

const has = (v) => typeof v === 'number' && Number.isFinite(v);
const fixed = (v, digits) => (has(v) ? v.toFixed(digits) : '—');

const degF = (v) => (has(v) ? `${v.toFixed(1)}°F` : '—');
const mph = (v) => (has(v) ? `${v.toFixed(1)} mph` : '—');
const inches = (v) => (has(v) ? `${v.toFixed(2)}"` : '—');
const inHg = (v) => (has(v) ? `${v.toFixed(2)} inHg` : '—');
const percent = (v) => (has(v) ? `${Math.round(v)}%` : '—');
const wm2 = (v) => (has(v) ? `${Math.round(v)} W/m²` : '—');
const uvi = (v) => (has(v) ? `${Math.round(v)}` : '—');

const compass = (deg) => (has(deg) ? COMPASS[Math.round(deg / 22.5) % 16] : '—');

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' });

/**
 * Axis labels follow the span, not the resolution: clock times read well across
 * a day and turn to noise across a week, where the reader wants the date.
 * The tooltip (`full`) always carries the whole timestamp.
 */
function axisFormatter(mode, spanMs) {
  if (mode === 'hires' && spanMs <= 1.5 * DAY_MS) {
    return (x, full) => (full ? fullFmt.format(x) : timeFmt.format(x));
  }
  if (mode === 'hires') return (x, full) => (full ? fullFmt.format(x) : dayFmt.format(x));
  if (spanMs > 200 * DAY_MS) return (x, full) => (full ? dateFmt.format(x) : monthFmt.format(x));
  return (x, full) => (full ? dateFmt.format(x) : dayFmt.format(x));
}

function relativeTime(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const durationText = (minutes) => `${Math.floor(minutes / 60)} h ${minutes % 60} m`;

/** Apparent temperature: heat index when it's warm, wind chill when it's cold. */
function apparent(record) {
  if (!has(record.tempF)) return null;
  if (record.tempF >= 70 && has(record.heatIndexF)) return record.heatIndexF;
  if (record.tempF <= 50 && has(record.windChillF)) return record.windChillF;
  return record.tempF;
}

// ─────────────────────────── small DOM helpers ───────────────────────────

function div(className, textContent) {
  const node = document.createElement('div');
  node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = textContent;
  return node;
}

// ─────────────────────────── theme ───────────────────────────

function initTheme() {
  const button = document.getElementById('theme-toggle');
  const stored = localStorage.getItem('wx-theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);

  const isDark = () => (document.documentElement.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const sync = () => { button.textContent = isDark() ? 'Light' : 'Dark'; };

  button.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('wx-theme', next);
    sync();
  });
  sync();
}

// ─────────────────────────── now: hero + facts ───────────────────────────

function renderStatus(observation) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  if (!observation?.epoch) {
    dot.className = 'status-dot';
    label.textContent = 'no data';
    return;
  }
  const age = (Date.now() - observation.epoch * 1000) / 60000;
  // The archive commits every ~15 minutes, so anything inside half an hour is
  // as live as this page can be; a few hours means the station stopped.
  dot.className = `status-dot ${age <= 30 ? 'live' : age <= 180 ? 'stale' : 'down'}`;
  label.textContent = age <= 30 ? 'live' : age <= 180 ? 'delayed' : 'offline';
}

function fact(label, value, sub) {
  const node = div('fact');
  node.append(div('fact-label', label), div('fact-value', value));
  if (sub) node.append(div('fact-sub', sub));
  return node;
}

function renderHero(latest, dayPoints) {
  const observation = latest?.observation;
  const today = latest?.today;
  const facts = document.getElementById('hero-facts');
  facts.replaceChildren();
  renderStatus(observation);
  if (!observation) return;

  document.getElementById('hero-temp').textContent = has(observation.tempF)
    ? observation.tempF.toFixed(1) : '—';

  const feels = apparent(observation);
  const feelsNode = document.getElementById('hero-feels');
  feelsNode.replaceChildren();
  if (has(feels)) {
    feelsNode.append('Feels like ');
    const strong = document.createElement('strong');
    strong.textContent = degF(feels);
    feelsNode.append(strong);
    if (has(observation.tempF) && Math.abs(feels - observation.tempF) >= 1) {
      feelsNode.append(feels > observation.tempF ? ' — humidity' : ' — wind');
    }
  }

  // Trend over the last hour, from the archive rather than a stored delta.
  const trend = document.getElementById('hero-trend');
  trend.textContent = '';
  if (has(observation.tempF) && dayPoints.length) {
    const target = observation.epoch * 1000 - 3600000;
    let closest = null;
    for (const point of dayPoints) {
      if (!has(point.tempF)) continue;
      if (!closest || Math.abs(point.x - target) < Math.abs(closest.x - target)) closest = point;
    }
    if (closest && Math.abs(closest.x - target) < 20 * 60000) {
      const delta = observation.tempF - closest.tempF;
      const arrow = delta > 0.1 ? '↑' : delta < -0.1 ? '↓' : '→';
      trend.textContent = `${arrow} ${Math.abs(delta).toFixed(1)}°F in the last hour`;
    }
  }

  document.getElementById('hero-time').textContent = has(observation.epoch)
    ? `${relativeTime(observation.epoch * 1000)} · ${fullFmt.format(observation.epoch * 1000)}`
    : 'no observations yet';

  const at = (epoch) => (has(epoch) ? `at ${timeFmt.format(epoch * 1000)}` : null);
  if (has(today?.tempMax)) facts.append(fact('Today high', degF(today.tempMax), at(today.tempMaxAt)));
  if (has(today?.tempMin)) facts.append(fact('Today low', degF(today.tempMin), at(today.tempMinAt)));
  if (has(today?.gustMax)) facts.append(fact('Peak gust', mph(today.gustMax), at(today.gustMaxAt)));
  facts.append(fact('Rain today', inches(observation.precipTotalIn),
    has(observation.precipRateIn) && observation.precipRateIn > 0
      ? `${fixed(observation.precipRateIn, 2)} in/hr now` : null));

  const meta = latest?.meta;
  const sun = has(meta?.lat) && has(meta?.lon)
    ? sunTimes(new Date(), meta.lat, meta.lon) : null;
  if (sun) {
    facts.append(fact('Sunrise', timeFmt.format(sun.sunrise)));
    facts.append(fact('Sunset', timeFmt.format(sun.sunset),
      `${durationText(sun.daylightMinutes)} of daylight`));
  }
}

// ─────────────────────────── now: metric rail ───────────────────────────

/**
 * One rail cell: the current value, today's range for context, and the last
 * 24 hours as a sparkline. The range is what stops a bare number from being
 * meaningless — 62°F reads differently after a high of 64 than after 88.
 */
function cell(spec) {
  const node = div('cell');
  node.append(div('cell-label', spec.label));

  const value = div('cell-value');
  value.textContent = spec.value;
  if (spec.unit) {
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = spec.unit;
    value.append(unit);
  }
  node.append(value, div('cell-sub', spec.sub || NBSP));

  const spark = div('cell-spark');
  node.append(spark);
  // Drawn by the caller once the cell is in the document: a detached element
  // measures zero width, and the sparkline would then size itself off nothing.
  node.drawSpark = () => {
    if (spec.series?.length) sparkline(spark, spec.series, spec.color || SERIES_1);
  };
  return node;
}

function renderRail(latest, dayPoints) {
  const rail = document.getElementById('rail');
  rail.replaceChildren();
  const observation = latest?.observation;
  const today = latest?.today;
  if (!observation) return;

  const series = (key) => dayPoints.map((point) => point[key]);
  const range = (lo, hi, format) => (has(lo) && has(hi) ? `${format(lo)} – ${format(hi)}` : null);

  rail.append(
    cell({
      label: 'Dew point',
      value: fixed(observation.dewptF, 1), unit: '°F',
      sub: range(today?.dewptMin, today?.dewptMax, (v) => v.toFixed(0)),
      series: series('dewptF'), color: SERIES_2,
    }),
    cell({
      label: 'Humidity',
      value: fixed(observation.humidity, 0), unit: '%',
      sub: range(today?.humidityMin, today?.humidityMax, (v) => `${v.toFixed(0)}%`),
      series: series('humidity'),
    }),
    cell({
      label: 'Wind',
      value: fixed(observation.windMph, 1), unit: 'mph',
      sub: `from ${compass(observation.windDir)}${has(observation.windDir) ? ` (${Math.round(observation.windDir)}°)` : ''}`,
      series: series('windMph'),
    }),
    cell({
      label: 'Gust',
      value: fixed(observation.gustMph, 1), unit: 'mph',
      sub: has(today?.gustMax) ? `peak ${fixed(today.gustMax, 1)} today` : null,
      series: series('gustMph'), color: SERIES_2,
    }),
    cell({
      label: 'Pressure',
      value: fixed(observation.pressureIn, 2), unit: 'inHg',
      sub: range(today?.pressureMin, today?.pressureMax, (v) => v.toFixed(2)),
      series: series('pressureIn'),
    }),
    cell({
      label: 'Rain today',
      value: fixed(observation.precipTotalIn, 2), unit: 'in',
      sub: has(today?.precipRateMax) && today.precipRateMax > 0
        ? `peak ${fixed(today.precipRateMax, 2)} in/hr` : 'no rain today',
      series: series('precipTotalIn'),
    }),
  );

  // Solar and UV only exist on stations with those sensors; a station without
  // them gets no empty cells rather than a row of dashes.
  if (dayPoints.some((point) => has(point.solarWm2))) {
    rail.append(cell({
      label: 'Solar',
      value: fixed(observation.solarWm2, 0), unit: 'W/m²',
      sub: has(today?.solarMax) ? `peak ${fixed(today.solarMax, 0)} today` : null,
      series: series('solarWm2'),
    }));
  }
  if (dayPoints.some((point) => has(point.uv))) {
    rail.append(cell({
      label: 'UV index',
      value: fixed(observation.uv, 0),
      sub: has(today?.uvMax) ? `peak ${fixed(today.uvMax, 0)} today` : null,
      series: series('uv'),
    }));
  }

  for (const node of rail.children) node.drawSpark?.();
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
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([x, v]) => ({ x, v }));
}

const speedBin = (mph) => {
  for (let i = 0; i < WIND_EDGES.length; i += 1) if (mph < WIND_EDGES[i]) return i;
  return WIND_EDGES.length;
};

/** Rose data: computed from raw observations, or summed from the daily rollups. */
function roseData(slice) {
  const sectors = Array.from({ length: 16 }, () => new Array(WIND_BINS.length).fill(0));
  let calm = 0;
  let total = 0;

  if (slice.mode === 'hires') {
    for (const point of slice.points) {
      if (!has(point.windMph) || !has(point.windDir)) continue;
      total += 1;
      if (point.windMph < CALM_MPH) { calm += 1; continue; }
      sectors[Math.round(point.windDir / 22.5) % 16][speedBin(point.windMph)] += 1;
    }
  } else {
    for (const day of slice.points) {
      const rose = day.rose;
      if (!rose?.sectors) continue;
      total += rose.total || 0;
      calm += rose.calm || 0;
      rose.sectors.forEach((counts, sector) => {
        counts.forEach((count, bin) => { sectors[sector][bin] += count; });
      });
    }
  }
  return { sectors, calm, total };
}

function renderCharts(slice) {
  const hires = slice.mode === 'hires';
  const points = slice.points;
  const span = points.length > 1 ? points[points.length - 1].x - points[0].x : 0;
  const xFormat = axisFormatter(slice.mode, span);

  // Compact end labels — the card header already states the unit.
  const endF = (v) => (has(v) ? `${v.toFixed(1)}°` : '');
  const end1 = (v) => (has(v) ? v.toFixed(1) : '');
  const end0 = (v) => (has(v) ? v.toFixed(0) : '');
  const end2 = (v) => (has(v) ? v.toFixed(2) : '');

  // ── temperature
  const temp = slots('chart-temp');
  if (hires) {
    // Apparent temperature equals the actual reading most of the time, and a
    // line drawn on top of another line just hides it. Plotting it only where
    // it diverges turns the third series into the thing worth seeing: the
    // stretches where humidity or wind actually changed how it felt.
    const withApparent = points.map((p) => {
      const feels = apparent(p);
      const diverges = has(feels) && has(p.tempF) && Math.abs(feels - p.tempF) >= 1;
      return { ...p, apparentF: diverges ? feels : null };
    });
    const series = [
      { key: 'tempF', name: 'Temperature', color: SERIES_1 },
      { key: 'dewptF', name: 'Dew point', color: SERIES_2 },
    ];
    // Only claim the third series in the legend when it actually appears.
    if (withApparent.some((p) => has(p.apparentF))) {
      series.push({ key: 'apparentF', name: 'Feels like (where it differs)', color: SERIES_3 });
    }
    document.getElementById('temp-sub').textContent = '°F · temperature, dew point, apparent';
    legend(temp.slot, series);
    lineChart(temp.chart, {
      points: withApparent, series, format: degF, formatEnd: endF,
      formatTick: (v) => v.toFixed(0), xFormat,
      ariaLabel: 'Temperature, dew point and apparent temperature over time',
    });
  } else {
    const series = [
      { key: 'tempAvg', name: 'Daily average', color: SERIES_1 },
      { key: 'dewptAvg', name: 'Dew point average', color: SERIES_2 },
    ];
    document.getElementById('temp-sub').textContent = '°F · daily high–low range, averages';
    legend(temp.slot, series);
    lineChart(temp.chart, {
      points, series,
      band: { lowKey: 'tempMin', highKey: 'tempMax', color: SERIES_1 },
      format: degF, formatEnd: endF, formatTick: (v) => v.toFixed(0), xFormat,
      ariaLabel: 'Daily temperature range, average temperature and dew point',
    });
  }

  // ── humidity
  const humidity = slots('chart-humidity');
  const humiditySeries = hires
    ? [{ key: 'humidity', name: 'Relative humidity', color: SERIES_1 }]
    : [{ key: 'humidityAvg', name: 'Daily average', color: SERIES_1 }];
  document.getElementById('humidity-sub').textContent = hires ? '%' : '% · daily range, average';
  legend(humidity.slot, humiditySeries);
  lineChart(humidity.chart, {
    points, series: humiditySeries,
    band: hires ? null : { lowKey: 'humidityMin', highKey: 'humidityMax', color: SERIES_1 },
    format: percent, formatEnd: end0, formatTick: (v) => v.toFixed(0), xFormat,
    ariaLabel: 'Relative humidity over time',
  });

  // ── wind speed
  const wind = slots('chart-wind');
  const windSeries = hires
    ? [{ key: 'windMph', name: 'Sustained', color: SERIES_1 },
       { key: 'gustMph', name: 'Gust', color: SERIES_2 }]
    : [{ key: 'windAvg', name: 'Daily average', color: SERIES_1 },
       { key: 'gustMax', name: 'Peak gust', color: SERIES_2 }];
  legend(wind.slot, windSeries);
  lineChart(wind.chart, {
    points, series: windSeries, format: mph, formatEnd: end1,
    formatTick: (v) => v.toFixed(0), xFormat,
    ariaLabel: 'Wind speed over time',
  });

  // ── wind direction
  const rose = slots('chart-rose');
  const roseInput = roseData(slice);
  document.getElementById('rose-sub').textContent = roseInput.total
    ? `${roseInput.sectors.length} sectors · ${((roseInput.calm / roseInput.total) * 100).toFixed(0)}% calm`
    : 'share of observations';
  legend(rose.slot, WIND_BINS.map((bin) => ({ name: bin.label, color: bin.color })), 'rect');
  windRose(rose.chart, {
    sectors: roseInput.sectors, bins: WIND_BINS, total: roseInput.total, names: COMPASS,
  });

  // ── pressure
  const pressure = slots('chart-pressure');
  if (hires) {
    const series = [{ key: 'pressureIn', name: 'Pressure', color: SERIES_1 }];
    legend(pressure.slot, series);
    lineChart(pressure.chart, {
      points, series, format: inHg, formatEnd: end2, formatTick: (v) => v.toFixed(2), xFormat,
      ariaLabel: 'Barometric pressure over time',
    });
  } else {
    const withMid = points.map((p) => ({
      ...p,
      pressureMid: has(p.pressureMin) && has(p.pressureMax)
        ? (p.pressureMin + p.pressureMax) / 2 : null,
    }));
    const series = [{ key: 'pressureMid', name: 'Daily midpoint', color: SERIES_1 }];
    legend(pressure.slot, series);
    lineChart(pressure.chart, {
      points: withMid, series,
      band: { lowKey: 'pressureMin', highKey: 'pressureMax', color: SERIES_1 },
      format: inHg, formatEnd: end2, formatTick: (v) => v.toFixed(2), xFormat,
      ariaLabel: 'Daily barometric pressure range',
    });
  }

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

  // ── solar radiation
  const solar = slots('chart-solar');
  const solarSeries = hires
    ? [{ key: 'solarWm2', name: 'Solar radiation', color: SERIES_1 }]
    : [{ key: 'solarMax', name: 'Daily peak', color: SERIES_1 }];
  legend(solar.slot, solarSeries);
  lineChart(solar.chart, {
    points, series: solarSeries, format: wm2, formatEnd: end0,
    formatTick: (v) => v.toFixed(0), xFormat,
    emptyMessage: 'This station does not report solar radiation.',
    ariaLabel: 'Solar radiation over time',
  });

  // ── UV index
  const uv = slots('chart-uv');
  const uvSeries = hires
    ? [{ key: 'uv', name: 'UV index', color: SERIES_1 }]
    : [{ key: 'uvMax', name: 'Daily peak', color: SERIES_1 }];
  document.getElementById('uv-sub').textContent = hires ? 'index' : 'index · daily peak';
  legend(uv.slot, uvSeries);
  lineChart(uv.chart, {
    points, series: uvSeries, format: uvi, formatEnd: end0,
    formatTick: (v) => v.toFixed(0), xFormat,
    emptyMessage: 'This station does not report UV.',
    ariaLabel: 'UV index over time',
  });
}

// ─────────────────────────── extremes ───────────────────────────

function extremeOf(points, key, direction) {
  let best = null;
  for (const point of points) {
    const value = point[key];
    if (!has(value)) continue;
    if (!best || (direction === 'max' ? value > best.v : value < best.v)) {
      best = { v: value, at: point.x };
    }
  }
  return best;
}

/**
 * Range extremes, computed from whichever resolution is loaded. The daily
 * rollups carry the timestamp of each day's extreme, so "when" survives the
 * switch to long ranges instead of degrading to a date.
 */
function rangeExtremes(slice) {
  const points = slice.points;
  const hires = slice.mode === 'hires';

  const pick = (hiresKey, dailyKey, dailyAtKey, direction) => {
    if (hires) return extremeOf(points, hiresKey, direction);
    let best = null;
    for (const day of points) {
      const value = day[dailyKey];
      if (!has(value)) continue;
      if (!best || (direction === 'max' ? value > best.v : value < best.v)) {
        // Only some rollup fields record the moment their extreme happened.
        // Where one doesn't, say the day and stop there rather than implying a
        // clock time the archive never stored.
        const exact = has(day[dailyAtKey]);
        best = { v: value, at: exact ? day[dailyAtKey] * 1000 : day.x, dayOnly: !exact };
      }
    }
    return best;
  };

  const totalRain = hires
    ? precipBuckets(points, 'day').reduce((sum, bucket) => sum + bucket.v, 0)
    : points.reduce((sum, day) => sum + (has(day.precipIn) ? day.precipIn : 0), 0);

  return [
    { label: 'Highest temp', got: pick('tempF', 'tempMax', 'tempMaxAt', 'max'), format: degF },
    { label: 'Lowest temp', got: pick('tempF', 'tempMin', 'tempMinAt', 'min'), format: degF },
    { label: 'Peak gust', got: pick('gustMph', 'gustMax', 'gustMaxAt', 'max'), format: mph },
    { label: 'Highest dew point', got: pick('dewptF', 'dewptMax', null, 'max'), format: degF },
    { label: 'Total rain', got: { v: totalRain, at: null }, format: inches },
    { label: 'Peak rain rate', got: pick('precipRateIn', 'precipRateMax', null, 'max'), format: (v) => `${fixed(v, 2)} in/hr` },
    { label: 'Highest humidity', got: pick('humidity', 'humidityMax', null, 'max'), format: percent },
    { label: 'Lowest humidity', got: pick('humidity', 'humidityMin', null, 'min'), format: percent },
    { label: 'Highest pressure', got: pick('pressureIn', 'pressureMax', null, 'max'), format: inHg },
    { label: 'Lowest pressure', got: pick('pressureIn', 'pressureMin', null, 'min'), format: inHg },
    { label: 'Peak solar', got: pick('solarWm2', 'solarMax', null, 'max'), format: wm2 },
    { label: 'Peak UV', got: pick('uv', 'uvMax', null, 'max'), format: uvi },
  ];
}

function renderExtremes(slice) {
  const container = document.getElementById('extremes');
  container.replaceChildren();

  const rows = rangeExtremes(slice).filter((row) => row.got && has(row.got.v));
  if (!rows.length) {
    container.append(div('empty', 'No observations in this range yet.'));
    return;
  }

  for (const row of rows) {
    const node = div('ex');
    node.append(div('ex-label', row.label), div('ex-value', row.format(row.got.v)));
    // A peak of zero never happened at a particular moment — the timestamp
    // would just be whichever sample the scan happened to reach first.
    const stamp = row.got.dayOnly ? dateFmt : fullFmt;
    const when = row.got.at && row.got.v !== 0 ? stamp.format(row.got.at) : NBSP;
    node.append(div('ex-when', when));
    container.append(node);
  }

  document.getElementById('extremes-note').textContent =
    slice.mode === 'hires' ? 'from full-resolution observations' : 'from daily rollups';
}

// ─────────────────────────── table view ───────────────────────────

const HIRES_COLUMNS = [
  ['Time', (p) => fullFmt.format(p.x)],
  ['Temp °F', (p) => fixed(p.tempF, 1)],
  ['Feels °F', (p) => fixed(apparent(p), 1)],
  ['Dew pt °F', (p) => fixed(p.dewptF, 1)],
  ['Hum %', (p) => fixed(p.humidity, 0)],
  ['Wind mph', (p) => fixed(p.windMph, 1)],
  ['Gust mph', (p) => fixed(p.gustMph, 1)],
  ['Dir', (p) => (has(p.windDir) ? `${compass(p.windDir)} ${Math.round(p.windDir)}°` : '—')],
  ['Press inHg', (p) => fixed(p.pressureIn, 2)],
  ['Rain in', (p) => fixed(p.precipTotalIn, 2)],
  ['Rate in/hr', (p) => fixed(p.precipRateIn, 2)],
  ['Solar W/m²', (p) => fixed(p.solarWm2, 0)],
  ['UV', (p) => fixed(p.uv, 0)],
];

const DAILY_COLUMNS = [
  ['Date', (p) => p.date],
  ['High °F', (p) => fixed(p.tempMax, 1)],
  ['Low °F', (p) => fixed(p.tempMin, 1)],
  ['Avg °F', (p) => fixed(p.tempAvg, 1)],
  ['Dew pt °F', (p) => fixed(p.dewptAvg, 1)],
  ['Hum %', (p) => fixed(p.humidityAvg, 0)],
  ['Hum min–max', (p) => (has(p.humidityMin) ? `${fixed(p.humidityMin, 0)}–${fixed(p.humidityMax, 0)}` : '—')],
  ['Wind mph', (p) => fixed(p.windAvg, 1)],
  ['Gust mph', (p) => fixed(p.gustMax, 1)],
  ['Rain in', (p) => fixed(p.precipIn, 2)],
  ['Rate in/hr', (p) => fixed(p.precipRateMax, 2)],
  ['Press min', (p) => fixed(p.pressureMin, 2)],
  ['Press max', (p) => fixed(p.pressureMax, 2)],
  ['Solar W/m²', (p) => fixed(p.solarMax, 0)],
  ['UV', (p) => fixed(p.uvMax, 0)],
  ['Obs', (p) => fixed(p.count, 0)],
];

const MAX_ROWS = 500;

function renderTable(slice) {
  const table = document.getElementById('data-table');
  const columns = slice.mode === 'hires' ? HIRES_COLUMNS : DAILY_COLUMNS;

  // Every value on screen is in here; long ranges are evenly sampled so the
  // table stays usable rather than shipping tens of thousands of rows.
  const stride = Math.max(1, Math.ceil(slice.points.length / MAX_ROWS));
  const rows = slice.points.filter((_, i) => i % stride === 0);

  document.getElementById('table-caption').textContent = stride > 1
    ? `${rows.length} of ${slice.points.length} observations (every ${stride}th).`
    : `${rows.length} row${rows.length === 1 ? '' : 's'}.`;

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
  const place = [
    has(meta?.lat) && has(meta?.lon) ? `${meta.lat.toFixed(3)}, ${meta.lon.toFixed(3)}` : null,
    has(meta?.elevationFt) ? `${Math.round(meta.elevationFt)} ft` : null,
    meta?.softwareType || null,
  ].filter(Boolean).join(' · ');
  document.getElementById('station-place').textContent = place || '—';

  // The "now" block is always the last 24 hours, whatever range is selected.
  const daySlice = await loadRange(1, index, daily);
  renderHero(latest, daySlice.points);
  renderRail(latest, daySlice.points);

  const note = document.getElementById('range-note');
  note.textContent = index.days.length
    ? `${index.days.length} day${index.days.length === 1 ? '' : 's'} archived · ${index.firstDate} → ${index.lastDate}`
    : 'No archived observations yet — run weather/tools/archive.mjs.';

  const charts = document.getElementById('charts');
  const extremes = document.getElementById('extremes');
  let token = 0;

  async function show(rangeDays) {
    const mine = ++token;
    charts.classList.add('loading');
    extremes.classList.add('loading');
    const slice = await loadRange(rangeDays, index, daily);
    if (mine !== token) return;               // a newer range won the race
    renderCharts(slice);
    renderExtremes(slice);
    renderTable(slice);
    charts.classList.remove('loading');
    extremes.classList.remove('loading');
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
