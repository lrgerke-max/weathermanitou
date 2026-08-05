#!/usr/bin/env node
//
// Preflight check. Run this first, from a machine with network access:
//
//   WU_API_KEY=… node tools/doctor.mjs
//
// Everything in this project was written against documented response shapes
// rather than live payloads, so the interesting failure is not "the request
// failed" — it is "the request succeeded and we read the wrong field names".
// This calls each configured API and reports, field by field, what actually
// came back, so a mapping mistake shows up as a named gap instead of a
// dashboard full of dashes.
//
// Exits non-zero if anything is broken, so it can gate a first deploy.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

let failures = 0;
let warnings = 0;

const pass = (msg) => console.log(`  ok    ${msg}`);
const warn = (msg) => { warnings += 1; console.log(`  warn  ${msg}`); };
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };
const section = (name) => console.log(`\n${name}`);

/** Split a record into the fields that arrived and the ones that didn't. */
function coverage(record, fields) {
  const present = [];
  const missing = [];
  for (const field of fields) {
    if (record[field] === null || record[field] === undefined) missing.push(field);
    else present.push(field);
  }
  return { present, missing };
}

// Fields every station reports. A gap here means a mapping error, not a
// missing sensor — no personal weather station omits temperature.
const CORE = ['epoch', 'tempF', 'dewptF', 'humidity', 'windMph', 'pressureIn', 'precipTotalIn'];
// Fields that depend on which sensors are attached.
const OPTIONAL = ['heatIndexF', 'windChillF', 'gustMph', 'windDir', 'precipRateIn', 'solarWm2', 'uv'];

async function checkObservations() {
  section('Weather Underground');
  if (!process.env.WU_API_KEY) {
    fail('WU_API_KEY is not set — export it, or add it as a repository secret');
    return;
  }

  const { fetchCurrent, fetchLastDay, STATION_ID } = await import('./wu.mjs');
  pass(`station ${STATION_ID}`);

  let current;
  try {
    current = await fetchCurrent();
  } catch (err) {
    fail(`current conditions: ${err.message}`);
    return;
  }

  if (!current) {
    warn('current conditions returned no observations — station may be offline');
  } else {
    const { record, meta } = current;
    const age = Math.round((Date.now() / 1000 - record.epoch) / 60);
    pass(`current conditions: ${record.tempF}°F, ${age} min old`);
    if (age > 60) warn(`newest observation is ${age} minutes old — is the station uploading?`);

    const core = coverage(record, CORE);
    if (core.missing.length) fail(`core fields missing: ${core.missing.join(', ')}`);
    else pass(`all core fields mapped: ${core.present.join(', ')}`);

    const extra = coverage(record, OPTIONAL);
    if (extra.present.length) pass(`optional sensors: ${extra.present.join(', ')}`);
    if (extra.missing.length) console.log(`        not reported: ${extra.missing.join(', ')}`);

    if (meta?.lat && meta?.lon) pass(`location ${meta.lat}, ${meta.lon} — sun times will work`);
    else warn('no coordinates in the payload — sunrise/sunset will be hidden');
    if (meta?.neighborhood) pass(`name "${meta.neighborhood}"`);
  }

  // The rapid-history endpoint uses different field spellings from current
  // conditions; this is the check that those were mapped correctly too.
  try {
    const day = await fetchLastDay();
    if (!day.length) {
      warn('rapid history returned nothing for the last 24 hours');
      return;
    }
    pass(`rapid history: ${day.length} observations in the last 24 hours`);
    const mapped = day.filter((r) => r.tempF !== null).length;
    if (mapped === 0) {
      fail('every rapid-history record has a null temperature — aggregate field names are wrong');
    } else if (mapped < day.length * 0.9) {
      warn(`${day.length - mapped} of ${day.length} rapid-history records have no temperature`);
    } else {
      pass('rapid-history field spellings map correctly');
    }
  } catch (err) {
    fail(`rapid history: ${err.message}`);
  }
}

async function checkLightning() {
  section('Lightning');
  const { configuredProvider, isLocatingNetwork, fetchStrikes, fetchLightning } =
    await import('./lightning.mjs');

  const provider = configuredProvider();
  if (!provider) {
    console.log('  skip  no provider configured (lightning stays hidden on the dashboard)');
    return;
  }
  pass(`provider ${provider}`);

  if (!isLocatingNetwork(provider)) {
    try {
      const reading = await fetchLightning();
      if (!reading) warn('no lightning sensor paired with this station');
      else pass(`detector: ${reading.countToday ?? 0} strikes today, ` +
        `last ${reading.lastDistanceMi ?? '—'} mi away`);
    } catch (err) {
      fail(`detector: ${err.message}`);
    }
    return;
  }

  const { stationCoords } = await import('./store.mjs');
  const station = await stationCoords();
  if (!station) {
    warn('station coordinates unknown — run archive.mjs once before fetching strikes');
    return;
  }

  try {
    // A wide window and radius: an empty answer during calm weather is normal
    // and proves nothing, so ask for as much as the free tier will give.
    const strikes = await fetchStrikes(station, 60, 300);
    if (!strikes.length) {
      warn('no strikes within 300 miles in the last hour — likely just calm weather, ' +
        'so this check proves the credentials work but not the parsing');
      return;
    }
    pass(`${strikes.length} strikes within 300 miles in the last hour`);

    const located = strikes.filter((s) => s.distanceMi !== null && s.bearingDeg !== null);
    if (!located.length) fail('no strike has a distance and bearing — the response shape differs');
    else pass(`${located.length} located; nearest ${Math.min(...located.map((s) => s.distanceMi))} mi`);

    if (strikes.every((s) => !s.type)) warn('no stroke types returned — cloud-to-ground count will be hidden');
    if (strikes.some((s) => !s.id)) fail('some strikes have no ID — deduplication would break');
  } catch (err) {
    fail(`strikes: ${err.message}`);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, path), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function checkArchive() {
  section('Archive');
  const index = await readJson('index.json', null);
  if (!index?.days?.length) {
    warn('nothing archived yet — run tools/archive.mjs');
    return;
  }
  pass(`${index.days.length} days archived, ${index.firstDate} → ${index.lastDate}`);

  const daily = await readJson('daily.json', { days: [] });
  if (daily.days.length !== index.days.length) {
    warn(`${index.days.length} day files but ${daily.days.length} rollup rows`);
  }

  // A gap means the archiver was down for a whole day; the charts will simply
  // skip it, but it is worth knowing about.
  const DAY = 86400000;
  let gaps = 0;
  for (let i = 1; i < index.days.length; i += 1) {
    const delta = Date.parse(index.days[i]) - Date.parse(index.days[i - 1]);
    if (delta > DAY) gaps += Math.round(delta / DAY) - 1;
  }
  if (gaps) warn(`${gaps} missing day(s) inside the range — backfill.mjs can fill them`);
  else pass('no gaps in the archived range');

  const latest = await readJson('latest.json', null);
  if (latest?.observation?.epoch) {
    const age = Math.round((Date.now() / 1000 - latest.observation.epoch) / 60);
    if (age > 120) warn(`latest.json is ${age} minutes old — is the workflow running?`);
    else pass(`latest.json is ${age} minutes old`);
  }

  try {
    const files = await readdir(join(DATA_DIR, 'lightning'));
    const days = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    if (days.length) pass(`${days.length} days of lightning archived`);
  } catch { /* no lightning tree yet, which is fine */ }
}

async function main() {
  section('Environment');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`Node ${process.versions.node} — this needs 18 or newer for built-in fetch`);
  else pass(`Node ${process.versions.node}`);

  await checkObservations();
  await checkLightning();
  await checkArchive();

  console.log('');
  if (failures) {
    console.log(`${failures} failure(s), ${warnings} warning(s).`);
    process.exit(1);
  }
  console.log(warnings ? `All clear, with ${warnings} warning(s).` : 'All clear.');
}

main().catch((err) => {
  console.error(`\ndoctor crashed: ${err.message}`);
  process.exit(1);
});
