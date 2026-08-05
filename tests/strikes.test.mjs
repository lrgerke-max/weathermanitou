// The lightning panel's maths. These are the parts that decide whether a
// strike counts as "near camp", so a quiet error here reads on the wall as
// calm weather during a storm.

import test from 'node:test';
import assert from 'node:assert/strict';

import { haversineMi, bearingDeg, recentStrikes } from '../js/strikes.js';

const CAMP = { lat: 42.7156, lon: -85.4589 };   // Middleville, MI
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol,
  `expected ${a} to be within ${tol} of ${b}`);

// ─────────────────────────── distance ───────────────────────────

test('distance to a point one degree of latitude north is ~69 miles', () => {
  near(haversineMi(CAMP.lat, CAMP.lon, CAMP.lat + 1, CAMP.lon), 69.09, 0.2);
});

test('distance is zero to itself, and symmetric', () => {
  assert.equal(haversineMi(CAMP.lat, CAMP.lon, CAMP.lat, CAMP.lon), 0);
  const there = { lat: 42.9634, lon: -85.6681 };  // Grand Rapids
  near(
    haversineMi(CAMP.lat, CAMP.lon, there.lat, there.lon),
    haversineMi(there.lat, there.lon, CAMP.lat, CAMP.lon),
    1e-9,
  );
});

test('a degree of longitude is shorter than a degree of latitude at 42°N', () => {
  const east = haversineMi(CAMP.lat, CAMP.lon, CAMP.lat, CAMP.lon + 1);
  near(east, 69.09 * Math.cos((CAMP.lat * Math.PI) / 180), 0.3);
});

// ─────────────────────────── bearing ───────────────────────────

test('bearing points the way the compass says', () => {
  near(bearingDeg(CAMP.lat, CAMP.lon, CAMP.lat + 1, CAMP.lon), 0, 0.5);    // N
  near(bearingDeg(CAMP.lat, CAMP.lon, CAMP.lat, CAMP.lon + 1), 90, 0.5);   // E
  near(bearingDeg(CAMP.lat, CAMP.lon, CAMP.lat - 1, CAMP.lon), 180, 0.5);  // S
  near(bearingDeg(CAMP.lat, CAMP.lon, CAMP.lat, CAMP.lon - 1), 270, 0.5);  // W
});

test('bearing is always in [0, 360)', () => {
  for (const [dLat, dLon] of [[1, 1], [-1, 1], [-1, -1], [1, -1], [0, -0.001]]) {
    const b = bearingDeg(CAMP.lat, CAMP.lon, CAMP.lat + dLat, CAMP.lon + dLon);
    assert.ok(b >= 0 && b < 360, `bearing ${b} out of range`);
  }
});

// ─────────────────────────── selection ───────────────────────────

const at = (minutesAgo, lat, lon, extra = {}) => ({
  id: `s${minutesAgo}`,
  epoch: Math.floor(Date.now() / 1000) - minutesAgo * 60,
  lat, lon, ...extra,
});

// ~0.29 degrees of latitude is ~20 miles; ~0.58 is ~40.
const NEAR = 0.29;
const FAR = 0.58;

test('strikes beyond the radius are excluded', () => {
  const rows = recentStrikes([
    at(1, CAMP.lat + NEAR, CAMP.lon),
    at(2, CAMP.lat + FAR, CAMP.lon),
  ], CAMP, 25, 5);
  assert.equal(rows.length, 1);
  near(rows[0].miles, 20, 0.5);
});

test('newest first, and no more than the limit', () => {
  const rows = recentStrikes([
    at(30, CAMP.lat + 0.05, CAMP.lon),
    at(5, CAMP.lat + 0.06, CAMP.lon),
    at(60, CAMP.lat + 0.07, CAMP.lon),
    at(1, CAMP.lat + 0.08, CAMP.lon),
  ], CAMP, 25, 3);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => Math.round((Date.now() / 1000 - r.epoch) / 60)), [1, 5, 30]);
});

test('the radius is inclusive: exactly 25 miles is inside, a hair over is not', () => {
  // Stated distances rather than coordinates, so the boundary is exact and the
  // test is not at the mercy of a miles-per-degree approximation.
  const epoch = Math.floor(Date.now() / 1000) - 60;
  const rows = recentStrikes([
    { id: 'on', epoch, distanceMi: 25 },
    { id: 'over', epoch: epoch - 1, distanceMi: 25.01 },
  ], CAMP, 25, 5);
  assert.deepEqual(rows.map((r) => r.miles), [25]);
});

test('distance is recomputed from coordinates, not trusted from the archive', () => {
  // distanceMi here is measured from the station; if the reference point moves,
  // the archived figure is stale and must lose to the recomputed one.
  const rows = recentStrikes(
    [at(1, CAMP.lat + NEAR, CAMP.lon, { distanceMi: 999, bearingDeg: 123 })],
    CAMP, 25, 5,
  );
  assert.equal(rows.length, 1);
  near(rows[0].miles, 20, 0.5);
  near(rows[0].bearing, 0, 0.5);
});

test('a bare detector, with a distance but no position, still counts', () => {
  const rows = recentStrikes([
    { id: 'd1', epoch: Math.floor(Date.now() / 1000) - 60, distanceMi: 8, bearingDeg: null },
    { id: 'd2', epoch: Math.floor(Date.now() / 1000) - 90, distanceMi: 44 },
  ], CAMP, 25, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].miles, 8);
  assert.equal(rows[0].bearing, null);
});

test('junk in the archive is skipped rather than thrown on', () => {
  const rows = recentStrikes([
    null,
    undefined,
    { id: 'no-epoch', lat: CAMP.lat, lon: CAMP.lon },
    { id: 'no-position', epoch: Math.floor(Date.now() / 1000) },
    at(1, CAMP.lat + 0.01, CAMP.lon),
  ], CAMP, 25, 5);
  assert.equal(rows.length, 1);
});

test('an empty or missing archive yields no rows', () => {
  assert.deepEqual(recentStrikes([], CAMP, 25, 5), []);
  assert.deepEqual(recentStrikes(null, CAMP, 25, 5), []);
  assert.deepEqual(recentStrikes(undefined, CAMP, 25, 5), []);
});

test('cloud-to-ground type is carried through for the display', () => {
  const rows = recentStrikes(
    [at(1, CAMP.lat + 0.01, CAMP.lon, { type: 'CG' })], CAMP, 25, 5,
  );
  assert.equal(rows[0].type, 'CG');
});
