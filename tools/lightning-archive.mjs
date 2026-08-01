#!/usr/bin/env node
//
// Poll the station's lightning detector and append to the archive.
//
//   ECOWITT_APPLICATION_KEY=… ECOWITT_API_KEY=… ECOWITT_MAC=… \
//     node weather/tools/lightning-archive.mjs
//
// Exits quietly when no provider is configured, so the scheduled workflow can
// run it unconditionally on stations that have no detector.

import { STATION_ID } from './wu.mjs';
import { configuredProvider, fetchLightning } from './lightning.mjs';
import {
  mergeLightning, updateLightningDaily, updateLightningIndex, writeLightningLatest,
} from './store.mjs';

async function main() {
  const provider = configuredProvider();
  if (!provider) {
    console.log('no lightning provider configured — skipping');
    return;
  }

  const reading = await fetchLightning();
  if (!reading) {
    console.log(`${provider}: no lightning sensor reported for this station`);
    return;
  }

  const { date } = await mergeLightning(STATION_ID, reading);
  const days = await updateLightningDaily([date]);
  await updateLightningIndex(STATION_ID, provider);
  await writeLightningLatest(STATION_ID, reading, days.find((row) => row.date === date) || null);

  const strikes = reading.countToday ?? 0;
  const distance = reading.lastDistanceMi !== null ? `, last ${reading.lastDistanceMi} mi away` : '';
  console.log(`${provider}: ${strikes} strike(s) today${distance}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
