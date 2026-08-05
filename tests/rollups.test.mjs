// Daily rollups. Long ranges are drawn entirely from these rows, so anything
// wrong here is invisible at 24 hours and wrong for a year.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, summariseLightning, summariseStrikes } from '../tools/store.mjs';

const at = (epoch, fields) => ({
  epoch, tempF: null, dewptF: null, heatIndexF: null, windChillF: null,
  humidity: null, windDir: null, windMph: null, gustMph: null,
  pressureIn: null, precipRateIn: null, precipTotalIn: null,
  solarWm2: null, uv: null, ...fields,
});

test('extremes carry the moment they happened', () => {
  const day = summarise('2026-08-01', [
    at(1000, { tempF: 60, gustMph: 5 }),
    at(2000, { tempF: 84, gustMph: 31 }),
    at(3000, { tempF: 55, gustMph: 12 }),
  ]);
  assert.equal(day.tempMax, 84);
  assert.equal(day.tempMaxAt, 2000);
  assert.equal(day.tempMin, 55);
  assert.equal(day.tempMinAt, 3000);
  assert.equal(day.gustMax, 31);
  assert.equal(day.gustMaxAt, 2000);
});

test('rainfall is the accumulator high-water mark, not a sum of samples', () => {
  // precipTotal counts up through the day; summing the samples would report
  // roughly ten times the rain that actually fell.
  const day = summarise('2026-08-01', [
    at(1, { precipTotalIn: 0.1 }),
    at(2, { precipTotalIn: 0.4 }),
    at(3, { precipTotalIn: 0.62 }),
    at(4, { precipTotalIn: 0.62 }),
  ]);
  assert.equal(day.precipIn, 0.62);
});

test('a day with no readings for a sensor reports null, not zero', () => {
  const day = summarise('2026-08-01', [at(1, { tempF: 70 })]);
  assert.equal(day.solarMax, null);
  assert.equal(day.uvMax, null);
  assert.equal(day.gustMax, null);
});

test('the wind rose bins by sector and speed, and counts calm separately', () => {
  const day = summarise('2026-08-01', [
    at(1, { windMph: 0.4, windDir: 90 }),    // calm: vane reading is meaningless
    at(2, { windMph: 3, windDir: 0 }),       // N,   bin 0
    at(3, { windMph: 7, windDir: 90 }),      // E,   bin 1
    at(4, { windMph: 15, windDir: 180 }),    // S,   bin 2
    at(5, { windMph: 25, windDir: 270 }),    // W,   bin 3
    at(6, { windMph: 40, windDir: 270 }),    // W,   bin 4
  ]);
  assert.equal(day.rose.total, 6);
  assert.equal(day.rose.calm, 1);
  assert.equal(day.rose.sectors[0][0], 1, 'N slow');
  assert.equal(day.rose.sectors[4][1], 1, 'E');
  assert.equal(day.rose.sectors[8][2], 1, 'S');
  assert.equal(day.rose.sectors[12][3], 1, 'W 20-30');
  assert.equal(day.rose.sectors[12][4], 1, 'W 30+');
  const binned = day.rose.sectors.flat().reduce((a, b) => a + b, 0);
  assert.equal(binned, day.rose.total - day.rose.calm);
});

test('a direction of 350 rounds into the north sector, not off the end', () => {
  const day = summarise('2026-08-01', [at(1, { windMph: 6, windDir: 355 })]);
  assert.equal(day.rose.sectors[0][1], 1);
});

// ─────────────────────────── lightning ───────────────────────────

const sample = (epoch, countToday, extra = {}) => ({
  epoch, countToday, lastStrikeEpoch: null, lastDistanceMi: null, ...extra,
});

test('detector strikes are summed from increments, not the counter peak', () => {
  const day = summariseLightning('2026-08-01', [
    sample(1, 0), sample(2, 12), sample(3, 30), sample(4, 30),
  ], 0);
  assert.equal(day.strikes, 30);
});

test('a counter that has not reset yet does not credit yesterday to today', () => {
  // The regression this exists for: taking the maximum reported 102 strikes on
  // a quiet morning, because the device had not rolled over.
  const day = summariseLightning('2026-08-02', [
    sample(1, 102), sample(2, 102), sample(3, 102),
  ], 0);
  assert.equal(day.strikes, 0);
});

test('strikes spanning the reset are counted from the new counter', () => {
  const day = summariseLightning('2026-08-02', [
    sample(1, 40), sample(2, 0), sample(3, 5), sample(4, 12),
  ], 0);
  assert.equal(day.strikes, 12);
});

test('a last-strike stamp from a previous day is not claimed as today', () => {
  const yesterday = Math.floor(Date.parse('2026-07-31T20:00:00Z') / 1000);
  const day = summariseLightning('2026-08-01', [
    sample(1, 0, { lastStrikeEpoch: yesterday, lastDistanceMi: 3.2 }),
  ], 0);
  assert.equal(day.closestMi, null);
  assert.equal(day.lastStrikeAt, null);
});

const strike = (epoch, distanceMi, bearingDeg, type = 'CG') =>
  ({ id: `s${epoch}`, epoch, lat: 0, lon: 0, distanceMi, bearingDeg, type });

test('located strikes summarise to count, closest and stroke type', () => {
  const day = summariseStrikes('2026-08-01', [
    strike(100, 22.5, 45, 'CG'),
    strike(200, 4.1, 200, 'IC'),
    strike(300, 60, 270, 'CG'),
  ]);
  assert.equal(day.strikes, 3);
  assert.equal(day.closestMi, 4.1);
  assert.equal(day.closestAt, 200);
  assert.equal(day.lastStrikeAt, 300);
  assert.equal(day.cg, 2);
  assert.equal(day.ic, 1);
});

test('the strike rose bins by bearing sector and distance band', () => {
  const day = summariseStrikes('2026-08-01', [
    strike(1, 2, 0),      // N,  0-5
    strike(2, 7, 90),     // E,  5-10
    strike(3, 20, 180),   // S,  10-25
    strike(4, 40, 270),   // W,  25-50
    strike(5, 80, 270),   // W,  50+
  ]);
  assert.equal(day.rose.total, 5);
  assert.equal(day.rose.sectors[0][0], 1);
  assert.equal(day.rose.sectors[4][1], 1);
  assert.equal(day.rose.sectors[8][2], 1);
  assert.equal(day.rose.sectors[12][3], 1);
  assert.equal(day.rose.sectors[12][4], 1);
});

test('strikes without a fix still count, but stay out of the rose', () => {
  const day = summariseStrikes('2026-08-01', [
    strike(1, 10, 45),
    { id: 'x', epoch: 2, distanceMi: null, bearingDeg: null, type: 'CG' },
  ]);
  assert.equal(day.strikes, 2, 'both counted');
  assert.equal(day.rose.total, 1, 'only the located one is placed');
});
