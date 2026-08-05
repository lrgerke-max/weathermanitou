// Sunrise/sunset from the station's coordinates. The dashboard shows these as
// plain facts, so being quietly an hour off would be worse than showing nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes } from '../js/sun.js';

const MIDDLEVILLE = { lat: 42.7114, lon: -85.4636 };

/** Minutes past UTC midnight, so assertions don't depend on the host timezone. */
const utcMinutes = (date) => date.getUTCHours() * 60 + date.getUTCMinutes();

test('midsummer in Michigan: sunrise, sunset and length of day', () => {
  const sun = sunTimes(new Date('2026-06-21T12:00:00Z'), MIDDLEVILLE.lat, MIDDLEVILLE.lon);
  // 21 June 2026: about 06:05 EDT rise, 21:23 EDT set — 10:05 and 01:23 UTC.
  assert.ok(Math.abs(utcMinutes(sun.sunrise) - 605) <= 4, sun.sunrise.toISOString());
  assert.ok(Math.abs(utcMinutes(sun.sunset) - 83) <= 4, sun.sunset.toISOString());
  // The solstice is the longest day of the year here: a shade over 15 hours.
  assert.ok(sun.daylightMinutes > 15 * 60 && sun.daylightMinutes < 15 * 60 + 30,
    `${sun.daylightMinutes} minutes`);
});

test('midwinter is markedly shorter than midsummer', () => {
  const winter = sunTimes(new Date('2026-12-21T12:00:00Z'), MIDDLEVILLE.lat, MIDDLEVILLE.lon);
  const summer = sunTimes(new Date('2026-06-21T12:00:00Z'), MIDDLEVILLE.lat, MIDDLEVILLE.lon);
  assert.ok(winter.daylightMinutes < 9 * 60 + 30, `${winter.daylightMinutes} minutes`);
  assert.ok(summer.daylightMinutes - winter.daylightMinutes > 5 * 60);
});

test('the equinox is close to twelve hours everywhere', () => {
  for (const lat of [0, 23.5, 42.7, 60]) {
    const sun = sunTimes(new Date('2026-03-20T12:00:00Z'), lat, -85.46);
    assert.ok(Math.abs(sun.daylightMinutes - 720) < 25,
      `lat ${lat}: ${sun.daylightMinutes} minutes`);
  }
});

test('sunrise precedes noon precedes sunset', () => {
  const sun = sunTimes(new Date('2026-08-01T12:00:00Z'), MIDDLEVILLE.lat, MIDDLEVILLE.lon);
  assert.ok(sun.sunrise < sun.noon, 'rise before noon');
  assert.ok(sun.noon < sun.sunset, 'noon before set');
  assert.equal(sun.daylightMinutes, Math.round((sun.sunset - sun.sunrise) / 60000));
});

test('the polar day has no sunrise, and says so instead of guessing', () => {
  assert.equal(sunTimes(new Date('2026-06-21T12:00:00Z'), 78, 15), null);
  assert.equal(sunTimes(new Date('2026-12-21T12:00:00Z'), 78, 15), null);
});

test('missing coordinates yield null rather than NaN times', () => {
  assert.equal(sunTimes(new Date(), undefined, undefined), null);
  assert.equal(sunTimes(new Date(), 42.7, null), null);
});

test('longitude shifts the clock the way it should', () => {
  // Three hours of longitude is about three hours of sunrise, west being later.
  const east = sunTimes(new Date('2026-08-01T12:00:00Z'), 42.7, -74);
  const west = sunTimes(new Date('2026-08-01T12:00:00Z'), 42.7, -119);
  const gap = (west.sunrise - east.sunrise) / 3600000;
  assert.ok(Math.abs(gap - 3) < 0.4, `${gap} hours apart`);
});
