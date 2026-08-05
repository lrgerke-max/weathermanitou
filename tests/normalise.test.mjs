// The observation normaliser: one flat record shape out of endpoints that
// disagree about spelling and about whether values are instants or aggregates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, localDate } from '../tools/wu.mjs';

// A current-conditions observation: instantaneous values, camelCase.
const CURRENT = {
  stationID: 'KMIMIDDL77',
  obsTimeUtc: '2026-08-01T18:20:00Z',
  obsTimeLocal: '2026-08-01 14:20:00',
  epoch: 1785608400,
  neighborhood: 'Middleville',
  humidity: 71,
  winddir: 210,
  solarRadiation: 640.2,
  uv: 5,
  imperial: {
    temp: 72.2, heatIndex: 74.1, dewpt: 62.3, windChill: 72.2,
    windSpeed: 5, windGust: 9, pressure: 29.92,
    precipRate: 0, precipTotal: 0.14, elev: 722,
  },
};

// The same station from history/all: per-bucket aggregates, different casing.
const HISTORY = {
  stationID: 'KMIMIDDL77',
  obsTimeUtc: '2026-07-31T18:20:00Z',
  obsTimeLocal: '2026-07-31 14:20:00',
  epoch: 1785522000,
  humidityAvg: 68,
  winddirAvg: 195,
  solarRadiationHigh: 705.5,
  uvHigh: 6,
  imperial: {
    tempAvg: 70.1, tempHigh: 74, tempLow: 66,
    heatindexAvg: 71.5, dewptAvg: 60.2, windchillAvg: 70.1,
    windspeedAvg: 4.2, windgustHigh: 11.3,
    pressureMax: 30.01, precipRate: 0.02, precipTotal: 0.31,
  },
};

test('reads instantaneous current-conditions fields', () => {
  const record = normalise(CURRENT);
  assert.equal(record.tempF, 72.2);
  assert.equal(record.dewptF, 62.3);
  assert.equal(record.heatIndexF, 74.1);
  assert.equal(record.windChillF, 72.2);
  assert.equal(record.humidity, 71);
  assert.equal(record.windDir, 210);
  assert.equal(record.windMph, 5);
  assert.equal(record.gustMph, 9);
  assert.equal(record.pressureIn, 29.92);
  assert.equal(record.precipTotalIn, 0.14);
  assert.equal(record.solarWm2, 640.2);
  assert.equal(record.uv, 5);
  assert.equal(record.epoch, 1785608400);
});

test('reads the history endpoint despite its different spellings', () => {
  const record = normalise(HISTORY);
  assert.equal(record.tempF, 70.1, 'tempAvg');
  assert.equal(record.heatIndexF, 71.5, 'heatindexAvg, lowercase i');
  assert.equal(record.windChillF, 70.1, 'windchillAvg, lowercase c');
  assert.equal(record.windMph, 4.2, 'windspeedAvg, lowercase s');
  assert.equal(record.gustMph, 11.3, 'windgustHigh');
  assert.equal(record.humidity, 68, 'humidityAvg');
  assert.equal(record.windDir, 195, 'winddirAvg');
  assert.equal(record.solarWm2, 705.5, 'solarRadiationHigh');
  assert.equal(record.uv, 6, 'uvHigh');
  assert.equal(record.pressureIn, 30.01, 'pressureMax');
});

test('both endpoints produce the same set of keys', () => {
  assert.deepEqual(
    Object.keys(normalise(CURRENT)).sort(),
    Object.keys(normalise(HISTORY)).sort()
  );
});

test('missing sensors come through as null, never zero', () => {
  const record = normalise({ epoch: 1, obsTimeUtc: 'x', imperial: {} });
  assert.equal(record.solarWm2, null);
  assert.equal(record.uv, null);
  assert.equal(record.tempF, null);
  assert.equal(record.humidity, null);
});

test('a genuine zero survives', () => {
  const record = normalise({ epoch: 1, imperial: { precipRate: 0, temp: 0 } });
  assert.equal(record.precipRateIn, 0);
  assert.equal(record.tempF, 0);
});

test('non-numeric junk becomes null rather than NaN', () => {
  const record = normalise({ epoch: 1, humidity: '', imperial: { temp: 'n/a' } });
  assert.equal(record.humidity, null);
  assert.equal(record.tempF, null);
});

test('days bucket by station-local date, not UTC', () => {
  // 8pm local on the 1st is already the 2nd in UTC; the archive must file it
  // under the 1st, because that is the day the station's counters belong to.
  const record = normalise({
    epoch: 1785632400,
    obsTimeUtc: '2026-08-02T01:00:00Z',
    obsTimeLocal: '2026-08-01 21:00:00',
    imperial: {},
  });
  assert.equal(localDate(record), '2026-08-01');
});

test('falls back to the UTC stamp when no local time is given', () => {
  assert.equal(localDate({ ts: '2026-08-02T01:00:00Z', local: null, epoch: 1 }), '2026-08-02');
});
