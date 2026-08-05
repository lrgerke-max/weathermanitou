#!/usr/bin/env node
//
// Archive lightning near the station.
//
//   XWEATHER_CLIENT_ID=… XWEATHER_CLIENT_SECRET=… \
//     node weather/tools/lightning-archive.mjs [--radius 150] [--minutes 30]
//
// With a locating network configured this stores individual strikes; with a
// local detector it stores counter readings instead. Exits quietly when neither
// is configured, so the scheduled workflow can run it unconditionally.

import { STATION_ID } from './wu.mjs';
import { configuredProvider, isLocatingNetwork, fetchStrikes, fetchLightning } from './lightning.mjs';
import {
  mergeStrikes, lastStrikeEpoch, stationCoords,
  mergeLightning, updateLightningDaily, updateLightningIndex, writeLightningLatest,
} from './store.mjs';

const DEFAULT_RADIUS_MI = 150;
const DEFAULT_MINUTES = 30;
// Long enough to ride out a few skipped scheduled runs, short enough that a
// first run after a long gap doesn't ask for a week in one request.
const MAX_MINUTES = 360;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

async function archiveStrikes(args) {
  const station = await stationCoords();
  if (!station) {
    console.warn('station coordinates unknown — run weather/tools/archive.mjs first');
    return;
  }

  const radius = Number(args.radius || DEFAULT_RADIUS_MI);
  let minutes = Number(args.minutes || DEFAULT_MINUTES);

  // Ask for everything since the last strike we hold, plus a minute of overlap.
  // Duplicates cost nothing (strikes merge on ID) and a gap costs data.
  const since = await lastStrikeEpoch();
  if (since && !args.minutes) {
    const elapsed = (Date.now() / 1000 - since) / 60;
    minutes = Math.min(MAX_MINUTES, Math.max(DEFAULT_MINUTES, Math.ceil(elapsed) + 1));
  }

  const strikes = await fetchStrikes(station, minutes, radius);
  console.log(`xweather: ${strikes.length} strike(s) within ${radius} mi in the last ${minutes} min`);

  const touched = await mergeStrikes(STATION_ID, 'xweather', strikes);
  const dates = touched.map((entry) => entry.date);
  const days = await updateLightningDaily(dates.length ? dates : []);
  await updateLightningIndex(STATION_ID, 'xweather');

  const newest = strikes.reduce((best, s) => (!best || s.epoch > best.epoch ? s : best), null);
  const today = days[days.length - 1] || null;
  await writeLightningLatest(STATION_ID, {
    epoch: Math.floor(Date.now() / 1000),
    provider: 'xweather',
    radiusMi: radius,
    lastStrikeEpoch: newest?.epoch ?? null,
    lastDistanceMi: newest?.distanceMi ?? null,
    lastBearingDeg: newest?.bearingDeg ?? null,
    lastType: newest?.type ?? null,
  }, today);

  if (touched.length) {
    console.log(`added ${touched.map((t) => `${t.added} on ${t.date}`).join(', ')}`);
  }
}

async function archiveDetector(provider) {
  const reading = await fetchLightning();
  if (!reading) {
    console.log(`${provider}: no lightning sensor reported for this station`);
    return;
  }

  const { date } = await mergeLightning(STATION_ID, reading);
  const days = await updateLightningDaily([date]);
  await updateLightningIndex(STATION_ID, provider);
  await writeLightningLatest(STATION_ID, reading, days.find((row) => row.date === date) || null);

  const distance = reading.lastDistanceMi !== null ? `, last ${reading.lastDistanceMi} mi away` : '';
  console.log(`${provider}: ${reading.countToday ?? 0} strike(s) today${distance}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = configuredProvider();
  if (!provider) {
    console.log('no lightning provider configured — skipping');
    return;
  }
  if (isLocatingNetwork(provider)) await archiveStrikes(args);
  else await archiveDetector(provider);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
