#!/usr/bin/env node
//
// Seed the archive with history that predates it.
//
//   WU_API_KEY=... node weather/tools/backfill.mjs --days 30
//   WU_API_KEY=... node weather/tools/backfill.mjs --from 2025-01-01 --to 2025-12-31
//
// One API call per day requested, paced a second apart. Days already in the
// archive are skipped unless --force is passed.

import { STATION_ID, fetchHistory } from './wu.mjs';
import { mergeRecords, readDay, updateDaily, updateIndex } from './store.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    if (name === 'force') args.force = true;
    else args[name] = argv[++i];
  }
  return args;
}

const DAY_MS = 86400000;
const iso = (date) => date.toISOString().slice(0, 10);
const compact = (date) => date.replace(/-/g, '');

function dateRange(args) {
  if (args.from) {
    const from = new Date(`${args.from}T00:00:00Z`);
    const to = new Date(`${args.to || iso(new Date())}T00:00:00Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new Error('--from/--to must be YYYY-MM-DD');
    }
    const dates = [];
    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) dates.push(iso(new Date(t)));
    return dates;
  }

  const days = Number(args.days || 7);
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
  const dates = [];
  // Yesterday backwards: today is still accumulating and archive.mjs owns it.
  for (let i = days; i >= 1; i -= 1) dates.push(iso(new Date(Date.now() - i * DAY_MS)));
  return dates;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dates = dateRange(args);
  console.log(`backfilling ${dates.length} day(s): ${dates[0]} → ${dates[dates.length - 1]}`);

  const touched = new Set();
  for (const date of dates) {
    if (!args.force && (await readDay(date))?.records?.length) {
      console.log(`${date}  skipped (already archived)`);
      continue;
    }
    try {
      const records = await fetchHistory(compact(date));
      if (!records.length) {
        console.log(`${date}  no data`);
      } else {
        for (const changed of await mergeRecords(STATION_ID, records)) touched.add(changed);
        console.log(`${date}  ${records.length} observations`);
      }
    } catch (err) {
      // One bad day shouldn't abandon the rest of the range.
      console.warn(`${date}  failed: ${err.message}`);
    }
    await sleep(1000);
  }

  if (touched.size) await updateDaily([...touched]);
  await updateIndex(STATION_ID);
  console.log(`done — ${touched.size} day file(s) written`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
