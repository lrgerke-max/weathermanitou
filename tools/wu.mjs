// Weather Underground / The Weather Company PWS API client.
//
// No dependencies — Node 18+ built-in fetch. Every function returns normalised
// records (see normalise()) so the rest of the toolchain never has to care which
// endpoint the data came from.
//
// The API key is read from the environment. It is never written to disk and must
// never be committed: locally use `export WU_API_KEY=...`, in CI use a repository
// secret of the same name.

const BASE = 'https://api.weather.com/v2/pws';

export const STATION_ID = process.env.WU_STATION_ID || 'KMIMIDDL77';

export function apiKey() {
  const key = process.env.WU_API_KEY;
  if (!key) {
    throw new Error(
      'WU_API_KEY is not set. Export it locally, or add it as a repository ' +
      'secret named WU_API_KEY for the archive workflow.'
    );
  }
  return key;
}

function url(path, params) {
  const u = new URL(BASE + path);
  u.searchParams.set('stationId', STATION_ID);
  u.searchParams.set('format', 'json');
  u.searchParams.set('units', 'e');            // imperial
  u.searchParams.set('numericPrecision', 'decimal');
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  u.searchParams.set('apiKey', apiKey());
  return u;
}

// Redact the key so it never reaches a log or an error message.
function safeUrl(u) {
  const clone = new URL(u);
  clone.searchParams.set('apiKey', 'REDACTED');
  return clone.toString();
}

async function get(path, params) {
  const u = url(path, params);
  let res;
  try {
    res = await fetch(u, { headers: { 'Accept-Encoding': 'gzip' } });
  } catch (err) {
    throw new Error(`request to ${safeUrl(u)} failed: ${err.message}`);
  }

  // 204 is WU's "no observations for that window" — an empty day, not an error.
  if (res.status === 204) return [];
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${res.status} ${res.statusText} from ${safeUrl(u)} ${body}`);
  }

  const json = await res.json();
  return Array.isArray(json.observations) ? json.observations : [];
}

// ─────────────────────────── normalisation ───────────────────────────
//
// The endpoints disagree about spelling and shape. `observations/current`
// returns instantaneous values (temp, windSpeed, heatIndex); the history and
// rapid-history endpoints return per-bucket aggregates with different casing
// (tempAvg, windspeedAvg, heatindexAvg). pick() tries each spelling in turn so
// one record shape covers all of them.

function pick(...candidates) {
  for (const value of candidates) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Collapse one raw observation into the flat record the archive stores.
 * All values imperial: °F, mph, inHg, in, W/m².
 */
export function normalise(obs) {
  const i = obs.imperial || {};
  return {
    epoch: num(obs.epoch),
    ts: obs.obsTimeUtc || null,
    local: obs.obsTimeLocal || null,
    tempF: num(pick(i.temp, i.tempAvg)),
    dewptF: num(pick(i.dewpt, i.dewptAvg)),
    heatIndexF: num(pick(i.heatIndex, i.heatindexAvg)),
    windChillF: num(pick(i.windChill, i.windchillAvg)),
    humidity: num(pick(obs.humidity, obs.humidityAvg)),
    windDir: num(pick(obs.winddir, obs.winddirAvg)),
    windMph: num(pick(i.windSpeed, i.windspeedAvg)),
    gustMph: num(pick(i.windGust, i.windgustHigh, i.windgustAvg)),
    pressureIn: num(pick(i.pressure, i.pressureMax, i.pressureAvg)),
    precipRateIn: num(i.precipRate),
    precipTotalIn: num(i.precipTotal),
    solarWm2: num(pick(obs.solarRadiation, obs.solarRadiationHigh)),
    uv: num(pick(obs.uv, obs.uvHigh)),
  };
}

/** The station-local calendar date (YYYY-MM-DD) an observation belongs to. */
export function localDate(record) {
  // obsTimeLocal looks like "2026-08-01 14:35:00" — already in station time, so
  // slicing beats any timezone arithmetic we could do here.
  if (record.local && /^\d{4}-\d{2}-\d{2}/.test(record.local)) {
    return record.local.slice(0, 10);
  }
  if (record.ts) return record.ts.slice(0, 10);
  if (record.epoch) return new Date(record.epoch * 1000).toISOString().slice(0, 10);
  return null;
}

// ─────────────────────────── endpoints ───────────────────────────

/**
 * Current conditions — one instantaneous record plus the station description
 * that rides along with it, or null if the station is offline.
 */
export async function fetchCurrent() {
  const observations = await get('/observations/current');
  if (!observations.length) return null;
  const raw = observations[0];
  return {
    record: normalise(raw),
    meta: {
      neighborhood: raw.neighborhood || null,
      lat: raw.lat ?? null,
      lon: raw.lon ?? null,
      elevationFt: raw.imperial?.elev ?? null,
      softwareType: raw.softwareType || null,
    },
  };
}

/**
 * Every observation from the past 24 hours at the station's native resolution
 * (typically ~5 minutes). Preferred over polling current conditions: one call
 * captures the whole window, so a delayed or skipped scheduled run loses nothing.
 */
export async function fetchLastDay() {
  const observations = await get('/observations/all/1day');
  return observations.map(normalise);
}

/** Historical observations for one calendar date, given as YYYYMMDD. */
export async function fetchHistory(yyyymmdd) {
  const observations = await get('/history/all', { date: yyyymmdd });
  return observations.map(normalise);
}
