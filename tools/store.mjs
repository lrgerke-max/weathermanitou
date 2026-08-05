// The archive on disk.
//
//   data/obs/YYYY-MM-DD.json   every observation for one station-local day
//   data/daily.json            one rollup row per day (drives the long-range charts)
//   data/latest.json           most recent observation + today's rollup
//   data/index.json            which days exist, for the dashboard to discover
//
// Plain JSON so the dashboard can fetch it straight off a static host with no
// server and no API key in client code.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from './wu.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, '..', 'data');
const OBS_DIR = join(DATA_DIR, 'obs');

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value) + '\n');
}

const obsPath = (date) => join(OBS_DIR, `${date}.json`);

// ─────────────────────────── merging ───────────────────────────

/**
 * Fold new records into the per-day files.
 *
 * Records are keyed by epoch, so re-fetching an overlapping window is free —
 * later data for the same timestamp wins, which is what we want when a
 * provisional reading is later corrected upstream.
 *
 * @returns {Promise<string[]>} the dates whose files actually changed
 */
export async function mergeRecords(station, records) {
  const byDate = new Map();
  for (const record of records) {
    if (record.epoch === null) continue;      // undateable, nothing to merge on
    const date = localDate(record);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(record);
  }

  const touched = [];
  for (const [date, incoming] of byDate) {
    const existing = await readJson(obsPath(date), null);
    const merged = new Map();
    for (const record of existing?.records || []) merged.set(record.epoch, record);

    let changed = false;
    for (const record of incoming) {
      const previous = merged.get(record.epoch);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) {
        merged.set(record.epoch, record);
        changed = true;
      }
    }
    if (!changed) continue;

    const sorted = [...merged.values()].sort((a, b) => a.epoch - b.epoch);
    await writeJson(obsPath(date), {
      station,
      date,
      units: 'imperial',
      records: sorted,
    });
    touched.push(date);
  }
  return touched.sort();
}

export async function readDay(date) {
  return readJson(obsPath(date), null);
}

// ─────────────────────────── rollups ───────────────────────────

const defined = (records, key) => records.map((r) => r[key]).filter((v) => v !== null);

function min(values) { return values.length ? Math.min(...values) : null; }
function max(values) { return values.length ? Math.max(...values) : null; }
function mean(values) {
  if (!values.length) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(avg * 10) / 10;
}

// Wind-rose binning. The dashboard computes the same bins from raw observations
// for short ranges — keep these edges and weather/js/app.js's WIND_BINS in step.
const ROSE_EDGES = [5, 10, 20, 30];    // mph; a fifth bin catches everything above
const CALM_MPH = 1;                    // below this the vane reading is meaningless

function speedBin(mph) {
  for (let i = 0; i < ROSE_EDGES.length; i += 1) if (mph < ROSE_EDGES[i]) return i;
  return ROSE_EDGES.length;
}

/**
 * Direction frequency by speed bin: 16 compass sectors × 5 bins.
 *
 * Stored per day so the rose works at any range — the raw observations are only
 * loaded for short ranges, but direction is worth having across a season.
 */
function windRose(records) {
  const sectors = Array.from({ length: 16 }, () => new Array(ROSE_EDGES.length + 1).fill(0));
  let calm = 0;
  let total = 0;
  for (const record of records) {
    if (record.windMph === null || record.windDir === null) continue;
    total += 1;
    if (record.windMph < CALM_MPH) { calm += 1; continue; }
    sectors[Math.round(record.windDir / 22.5) % 16][speedBin(record.windMph)] += 1;
  }
  return { total, calm, sectors };
}

/** The extreme value of one field, and the epoch it happened at. */
function peak(records, key, direction) {
  let best = null;
  for (const record of records) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    if (!best || (direction === 'max' ? value > best.v : value < best.v)) {
      best = { v: value, at: record.epoch };
    }
  }
  return best || { v: null, at: null };
}

/**
 * One day of observations → the summary row the dashboard charts.
 *
 * Long ranges render from these rows rather than the raw observations, so every
 * field the dashboard can show at full resolution has a daily counterpart here —
 * extremes carry the time they happened, not just the number.
 */
export function summarise(date, records) {
  const tempMax = peak(records, 'tempF', 'max');
  const tempMin = peak(records, 'tempF', 'min');
  const gustMax = peak(records, 'gustMph', 'max');

  return {
    date,
    count: records.length,

    tempMax: tempMax.v,
    tempMaxAt: tempMax.at,
    tempMin: tempMin.v,
    tempMinAt: tempMin.at,
    tempAvg: mean(defined(records, 'tempF')),

    dewptAvg: mean(defined(records, 'dewptF')),
    dewptMax: max(defined(records, 'dewptF')),
    dewptMin: min(defined(records, 'dewptF')),

    heatIndexMax: max(defined(records, 'heatIndexF')),
    windChillMin: min(defined(records, 'windChillF')),

    humidityAvg: mean(defined(records, 'humidity')),
    humidityMax: max(defined(records, 'humidity')),
    humidityMin: min(defined(records, 'humidity')),

    windAvg: mean(defined(records, 'windMph')),
    gustMax: gustMax.v,
    gustMaxAt: gustMax.at,

    // precipTotal is a running accumulator that resets at local midnight, so the
    // day's rainfall is its high-water mark, not a sum of the samples.
    precipIn: max(defined(records, 'precipTotalIn')),
    precipRateMax: max(defined(records, 'precipRateIn')),

    pressureMin: min(defined(records, 'pressureIn')),
    pressureMax: max(defined(records, 'pressureIn')),

    solarMax: max(defined(records, 'solarWm2')),
    uvMax: max(defined(records, 'uv')),

    rose: windRose(records),
  };
}

/** Recompute the rollup rows for the given dates and merge them into daily.json. */
export async function updateDaily(dates) {
  const path = join(DATA_DIR, 'daily.json');
  const existing = await readJson(path, { days: [] });
  const byDate = new Map((existing.days || []).map((day) => [day.date, day]));

  for (const date of dates) {
    const day = await readDay(date);
    if (day?.records?.length) byDate.set(date, summarise(date, day.records));
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeJson(path, { units: 'imperial', days });
  return days;
}

/** Rewrite index.json from whatever day files are actually present. */
export async function updateIndex(station) {
  let files = [];
  try {
    files = await readdir(OBS_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const days = files
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .sort();

  await writeJson(join(DATA_DIR, 'index.json'), {
    station,
    units: 'imperial',
    updatedAt: new Date().toISOString(),
    firstDate: days[0] || null,
    lastDate: days[days.length - 1] || null,
    days,
  });
  return days;
}

// ─────────────────────────── lightning ───────────────────────────
//
// Kept in its own tree under data/lightning/ because it comes from a different
// provider on a different cadence: the observation archive must not gain or
// lose days depending on whether a lightning detector happens to be configured.

const LIGHTNING_DIR = join(DATA_DIR, 'lightning');

/**
 * The station's UTC offset in minutes, taken from the observation archive.
 *
 * The strike counter resets at *station-local* midnight, but this runs in CI
 * under UTC, so bucketing by the runner's date would split a storm across two
 * days. The WU payload carries both a local and a UTC timestamp, which is
 * exactly the offset needed. Falls back to UTC when nothing is archived yet.
 */
async function stationOffsetMinutes() {
  const latest = await readJson(join(DATA_DIR, 'latest.json'), null);
  const observation = latest?.observation;
  if (!observation?.local || !observation?.epoch) return 0;
  const asIfUtc = Date.parse(`${observation.local.replace(' ', 'T')}Z`);
  if (Number.isNaN(asIfUtc)) return 0;
  return Math.round((asIfUtc / 1000 - observation.epoch) / 60);
}

const localDateFor = (epoch, offsetMinutes) =>
  new Date((epoch + offsetMinutes * 60) * 1000).toISOString().slice(0, 10);

/** The station's coordinates, as reported in its own observations. */
export async function stationCoords() {
  const latest = await readJson(join(DATA_DIR, 'latest.json'), null);
  const meta = latest?.meta;
  if (typeof meta?.lat !== 'number' || typeof meta?.lon !== 'number') return null;
  return { lat: meta.lat, lon: meta.lon };
}

// Strike-distance bands for the direction rose, in miles. Ordered, so the
// dashboard draws them with the ordinal ramp rather than eight competing hues.
const STRIKE_BANDS = [5, 10, 25, 50];

function distanceBand(miles) {
  for (let i = 0; i < STRIKE_BANDS.length; i += 1) if (miles < STRIKE_BANDS[i]) return i;
  return STRIKE_BANDS.length;
}

/**
 * Merge individual strikes into their station-local days, keyed by the
 * provider's strike ID.
 *
 * Every run asks the provider for an overlapping window, so re-seeing a strike
 * is the normal case, not an error — the ID is what makes that free.
 */
export async function mergeStrikes(station, provider, strikes) {
  const offset = await stationOffsetMinutes();
  const byDate = new Map();
  for (const strike of strikes) {
    if (!strike.epoch) continue;
    const date = localDateFor(strike.epoch, offset);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(strike);
  }

  const touched = [];
  for (const [date, incoming] of byDate) {
    const path = join(LIGHTNING_DIR, `${date}.json`);
    const existing = await readJson(path, null);
    const merged = new Map((existing?.strikes || []).map((s) => [s.id, s]));

    let added = 0;
    for (const strike of incoming) {
      if (merged.has(strike.id)) continue;
      merged.set(strike.id, strike);
      added += 1;
    }
    if (!added) continue;

    await writeJson(path, {
      station,
      date,
      provider,
      units: 'imperial',
      strikes: [...merged.values()].sort((a, b) => a.epoch - b.epoch),
      ...(existing?.samples ? { samples: existing.samples } : {}),
    });
    touched.push({ date, added });
  }
  return touched;
}

/** The newest strike already archived, for choosing the next fetch window. */
export async function lastStrikeEpoch() {
  const index = await readJson(join(LIGHTNING_DIR, 'index.json'), null);
  const date = index?.lastDate;
  if (!date) return null;
  const day = await readJson(join(LIGHTNING_DIR, `${date}.json`), null);
  const strikes = day?.strikes;
  if (!strikes?.length) return null;
  return strikes[strikes.length - 1].epoch;
}

/** Append one lightning reading to its station-local day. */
export async function mergeLightning(station, reading) {
  const offset = await stationOffsetMinutes();
  const date = localDateFor(reading.epoch, offset);
  const path = join(LIGHTNING_DIR, `${date}.json`);
  const existing = await readJson(path, null);
  const samples = existing?.samples || [];

  const last = samples[samples.length - 1];
  const unchanged = last
    && last.countToday === reading.countToday
    && last.lastStrikeEpoch === reading.lastStrikeEpoch
    && last.lastDistanceMi === reading.lastDistanceMi;

  // A quiet sky produces an identical reading every run. Storing one row per
  // poll would bloat the archive with nothing, so only changes are kept — but
  // the first sample of each day is always written, so a day with no strikes
  // still records that the detector was up and watching.
  if (unchanged && existing) return { date, changed: false };

  samples.push({
    epoch: reading.epoch,
    countToday: reading.countToday,
    lastStrikeEpoch: reading.lastStrikeEpoch,
    lastDistanceMi: reading.lastDistanceMi,
  });

  await writeJson(path, { station, date, provider: reading.provider, units: 'imperial', samples });
  return { date, changed: true };
}

/**
 * One day of located strikes → its summary row.
 *
 * Carries a direction rose (16 sectors × distance band) for the same reason the
 * observations do: long ranges are drawn from these rows, and direction should
 * survive that switch without loading a season of individual strikes.
 */
function summariseStrikes(date, strikes) {
  const sectors = Array.from({ length: 16 }, () => new Array(STRIKE_BANDS.length + 1).fill(0));
  let closest = null;
  let lastAt = null;
  let cg = 0;
  let ic = 0;
  let located = 0;

  for (const strike of strikes) {
    if (lastAt === null || strike.epoch > lastAt) lastAt = strike.epoch;
    if (/^cg/i.test(strike.type || '')) cg += 1;
    else if (/^ic/i.test(strike.type || '')) ic += 1;

    const distance = strike.distanceMi;
    if (typeof distance !== 'number') continue;
    if (!closest || distance < closest.mi) closest = { mi: distance, at: strike.epoch };
    if (typeof strike.bearingDeg !== 'number') continue;
    sectors[Math.round(strike.bearingDeg / 22.5) % 16][distanceBand(distance)] += 1;
    located += 1;
  }

  return {
    date,
    strikes: strikes.length,
    closestMi: closest?.mi ?? null,
    closestAt: closest?.at ?? null,
    lastStrikeAt: lastAt,
    cg,
    ic,
    rose: { total: located, sectors },
  };
}

/** One day of detector samples → its summary row. */
export function summariseLightning(date, samples, offsetMinutes) {
  // Strikes are the sum of the counter's positive increments, not its daily
  // high-water mark. A counter that has not reset yet still reads yesterday's
  // total, and taking the maximum would credit those strikes to today as well;
  // increments simply see a flat counter and score it zero. It also matches how
  // the dashboard derives its per-hour bars, so the two never disagree.
  let strikes = 0;
  let previous = null;
  for (const sample of samples) {
    const count = sample.countToday;
    if (count === null || count === undefined) continue;
    if (previous !== null && count > previous) strikes += count - previous;
    previous = count;
  }

  let closest = null;
  let lastStrikeAt = null;
  for (const sample of samples) {
    if (!sample.lastStrikeEpoch) continue;
    // The "last strike" fields can still describe yesterday's storm, so only
    // count a strike towards this day when it actually happened on it.
    if (localDateFor(sample.lastStrikeEpoch, offsetMinutes) !== date) continue;
    if (lastStrikeAt === null || sample.lastStrikeEpoch > lastStrikeAt) {
      lastStrikeAt = sample.lastStrikeEpoch;
    }
    const distance = sample.lastDistanceMi;
    if (distance === null || distance === undefined) continue;
    if (!closest || distance < closest.mi) closest = { mi: distance, at: sample.lastStrikeEpoch };
  }

  return {
    date,
    strikes,
    closestMi: closest?.mi ?? null,
    closestAt: closest?.at ?? null,
    lastStrikeAt,
    samples: samples.length,
  };
}

export async function updateLightningDaily(dates) {
  const offset = await stationOffsetMinutes();
  const path = join(LIGHTNING_DIR, 'daily.json');
  const existing = await readJson(path, { days: [] });
  const byDate = new Map((existing.days || []).map((day) => [day.date, day]));

  for (const date of dates) {
    const day = await readJson(join(LIGHTNING_DIR, `${date}.json`), null);
    // Located strikes beat a counter whenever both exist: they carry distance,
    // direction and stroke type, where the counter carries only a total.
    if (day?.strikes?.length) byDate.set(date, summariseStrikes(date, day.strikes));
    else if (day?.samples?.length) byDate.set(date, summariseLightning(date, day.samples, offset));
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeJson(path, { units: 'imperial', days });
  return days;
}

export async function updateLightningIndex(station, provider) {
  let files = [];
  try {
    files = await readdir(LIGHTNING_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const days = files
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, -5))
    .sort();

  await writeJson(join(LIGHTNING_DIR, 'index.json'), {
    station,
    provider,
    units: 'imperial',
    updatedAt: new Date().toISOString(),
    firstDate: days[0] || null,
    lastDate: days[days.length - 1] || null,
    days,
  });
  return days;
}

export async function writeLightningLatest(station, reading, todayRollup) {
  await writeJson(join(LIGHTNING_DIR, 'latest.json'), {
    station,
    provider: reading.provider,
    units: 'imperial',
    fetchedAt: new Date().toISOString(),
    reading,
    today: todayRollup,
  });
}

export async function readLightningDay(date) {
  return readJson(join(LIGHTNING_DIR, `${date}.json`), null);
}

export async function lightningLocalDate(epoch) {
  return localDateFor(epoch, await stationOffsetMinutes());
}

export async function writeLatest(station, record, todayRollup, meta) {
  const path = join(DATA_DIR, 'latest.json');
  // Station description only comes with the current-conditions call; keep the
  // last one we saw rather than blanking it when that call fails.
  const previous = await readJson(path, null);
  await writeJson(path, {
    station,
    units: 'imperial',
    fetchedAt: new Date().toISOString(),
    meta: meta || previous?.meta || null,
    observation: record,
    today: todayRollup,
  });
}
