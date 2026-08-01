#!/usr/bin/env node
//
// Pull the station's recent observations into the archive.
//
//   WU_API_KEY=... node weather/tools/archive.mjs
//
// Run it as often as you like — every run pulls the last 24 hours at full
// resolution and merges by timestamp, so overlapping runs are harmless and a
// missed run is caught up by the next one.

import { STATION_ID, fetchCurrent, fetchLastDay, localDate } from './wu.mjs';
import { mergeRecords, readDay, summarise, updateDaily, updateIndex, writeLatest } from './store.mjs';

async function main() {
  const day = await fetchLastDay();
  console.log(`fetched ${day.length} observations from the last 24h`);

  // Current conditions are fresher than the rapid-history aggregate, which lags
  // by up to one bucket. Not fatal if it fails — the archive is the point.
  let latest = null;
  try {
    latest = await fetchCurrent();
  } catch (err) {
    console.warn(`current conditions unavailable: ${err.message}`);
  }

  const current = latest?.record || null;
  const records = current ? [...day, current] : day;
  if (!records.length) {
    console.warn('no observations returned — station may be offline');
    return;
  }

  const touched = await mergeRecords(STATION_ID, records);
  console.log(touched.length ? `updated ${touched.join(', ')}` : 'no new observations');

  if (touched.length) await updateDaily(touched);
  await updateIndex(STATION_ID);

  const newest = current || records.reduce((a, b) => (b.epoch > a.epoch ? b : a));
  const date = localDate(newest);
  const stored = date ? await readDay(date) : null;
  await writeLatest(
    STATION_ID,
    newest,
    stored?.records?.length ? summarise(date, stored.records) : null,
    latest?.meta || null
  );
  console.log(`latest: ${newest.tempF}°F at ${newest.local || newest.ts}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
