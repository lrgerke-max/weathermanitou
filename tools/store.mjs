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

/** One day of observations → the summary row the dashboard charts. */
export function summarise(date, records) {
  const temps = defined(records, 'tempF');
  return {
    date,
    count: records.length,
    tempMax: max(temps),
    tempMin: min(temps),
    tempAvg: mean(temps),
    dewptAvg: mean(defined(records, 'dewptF')),
    humidityAvg: mean(defined(records, 'humidity')),
    windAvg: mean(defined(records, 'windMph')),
    gustMax: max(defined(records, 'gustMph')),
    // precipTotal is a running accumulator that resets at local midnight, so the
    // day's rainfall is its high-water mark, not a sum of the samples.
    precipIn: max(defined(records, 'precipTotalIn')),
    precipRateMax: max(defined(records, 'precipRateIn')),
    pressureMin: min(defined(records, 'pressureIn')),
    pressureMax: max(defined(records, 'pressureIn')),
    solarMax: max(defined(records, 'solarWm2')),
    uvMax: max(defined(records, 'uv')),
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
