// Loading the archive. Everything here reads static JSON committed by
// tools/archive.mjs — no API key, no server.

const DATA = 'data';

async function json(path) {
  // The single-file build (tools/build-single.mjs) embeds the archive
  // in the page itself, so the same dashboard runs with no server and no
  // network — straight off a file:// URL or an email attachment.
  const snapshot = globalThis.__WX_SNAPSHOT;
  if (snapshot) {
    if (!(path in snapshot)) throw new Error(`${path} is not in this snapshot`);
    return snapshot[path];
  }

  const res = await fetch(`${DATA}/${path}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} fetching ${path}`);
  return res.json();
}

/** Missing files are the normal state of a brand-new archive, not an error. */
async function optional(path, fallback) {
  try {
    return await json(path);
  } catch {
    return fallback;
  }
}

export function loadIndex() { return optional('index.json', { station: null, days: [] }); }
export function loadDaily() { return optional('daily.json', { days: [] }); }
export function loadLatest() { return optional('latest.json', null); }

/** Fetch several day files at once; days that fail are skipped. */
export async function loadDays(dates) {
  const files = await Promise.all(dates.map((date) => optional(`obs/${date}.json`, null)));
  return files
    .filter((file) => file && Array.isArray(file.records))
    .flatMap((file) => file.records);
}

// ─────────────────────────── lightning ───────────────────────────
//
// A separate tree, and every loader tolerates its absence: most stations have
// no detector, and the dashboard simply hides the lightning pieces when the
// files are not there.

export function loadLightningIndex() { return optional('lightning/index.json', { days: [] }); }
export function loadLightningDaily() { return optional('lightning/daily.json', { days: [] }); }
export function loadLightningLatest() { return optional('lightning/latest.json', null); }

/**
 * Two shapes come back depending on the source: `strikes` are individual
 * located events (a locating network), `samples` are counter readings (a local
 * detector). Callers prefer strikes when present — they carry distance,
 * direction and stroke type.
 */
export async function loadLightningRange(rangeDays, index, daily) {
  if (rangeDays > 0 && rangeDays <= 7) {
    const dates = (index.days || []).slice(-(rangeDays + 1));
    const files = await Promise.all(
      dates.map((date) => optional(`lightning/${date}.json`, null))
    );

    const withX = (rows) => rows
      .sort((a, b) => a.epoch - b.epoch)
      .map((row) => ({ ...row, x: row.epoch * 1000 }));

    return {
      mode: 'hires',
      strikes: withX(files.flatMap((file) => file?.strikes || [])),
      samples: withX(files.flatMap((file) => file?.samples || [])),
      points: [],
    };
  }

  let days = daily.days || [];
  if (rangeDays > 0) days = days.slice(-rangeDays);
  return {
    mode: 'daily',
    strikes: [],
    samples: [],
    points: days.map((day) => ({ ...day, x: new Date(`${day.date}T12:00:00`).getTime() })),
  };
}

const DAY_MS = 86400000;

/**
 * The slice the whole dashboard renders against.
 *
 * Short ranges use the full-resolution observations; long ones use the daily
 * rollups, because 90 days of five-minute samples is ~26,000 points fighting
 * over 600 pixels — the rollup is both faster and more readable.
 *
 * @param {number} rangeDays  1 / 7 / 30 / 90, or 0 for everything
 */
export async function loadRange(rangeDays, index, daily) {
  const hires = rangeDays > 0 && rangeDays <= 7;

  if (hires) {
    const dates = index.days.slice(-(rangeDays + 1));   // +1 covers a part-day edge
    const records = await loadDays(dates);
    if (!records.length) return { mode: 'hires', points: [] };

    const newest = Math.max(...records.map((r) => r.epoch));
    const cutoff = newest - rangeDays * 86400;
    const points = records
      .filter((r) => r.epoch >= cutoff)
      .sort((a, b) => a.epoch - b.epoch)
      .map((r) => ({ ...r, x: r.epoch * 1000 }));
    return { mode: 'hires', points };
  }

  let days = daily.days || [];
  if (rangeDays > 0) days = days.slice(-rangeDays);
  const points = days.map((day) => ({
    ...day,
    // Anchor each day at local midday so the marker sits under its tick.
    x: new Date(`${day.date}T12:00:00`).getTime(),
  }));
  return { mode: 'daily', points };
}
