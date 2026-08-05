// Provider response parsing, against stubbed HTTP.
//
// These are the parts that have never met a real payload, so this is where the
// guesses about field names and units get pinned down. When a live run
// disagrees with one of these fixtures, fix the fixture and the parser together
// — the test is the record of what we believe the API returns.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const ENV_KEYS = [
  'WU_API_KEY', 'WU_STATION_ID',
  'XWEATHER_CLIENT_ID', 'XWEATHER_CLIENT_SECRET',
  'ECOWITT_APPLICATION_KEY', 'ECOWITT_API_KEY', 'ECOWITT_MAC',
  'AMBIENT_APPLICATION_KEY', 'AMBIENT_API_KEY', 'AMBIENT_MAC',
];
const savedEnv = {};

let calls = [];

/** Answer the next fetch with this body, and record the URL that asked. */
function stub(body, { status = 200 } = {}) {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'stubbed',
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

beforeEach(() => {
  calls = [];
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const param = (url, name) => new URL(url).searchParams.get(name);

// ─────────────────────────── Weather Underground ───────────────────────────

test('the WU request carries station, imperial units and decimal precision', async () => {
  process.env.WU_API_KEY = 'secret-key';
  const { fetchCurrent } = await import('../tools/wu.mjs');
  stub({ observations: [{ epoch: 1, imperial: { temp: 70 } }] });

  await fetchCurrent();
  assert.equal(param(calls[0], 'stationId'), 'KMIMIDDL77');
  assert.equal(param(calls[0], 'units'), 'e');
  assert.equal(param(calls[0], 'numericPrecision'), 'decimal');
  assert.equal(param(calls[0], 'format'), 'json');
});

test('current conditions come back with the station description attached', async () => {
  process.env.WU_API_KEY = 'k';
  const { fetchCurrent } = await import('../tools/wu.mjs');
  stub({
    observations: [{
      epoch: 1785608400,
      neighborhood: 'Middleville',
      lat: 42.7114,
      lon: -85.4636,
      softwareType: 'GW1100A_V2.4.2',
      imperial: { temp: 72.2, elev: 722 },
    }],
  });

  const { record, meta } = await fetchCurrent();
  assert.equal(record.tempF, 72.2);
  assert.equal(meta.neighborhood, 'Middleville');
  assert.equal(meta.lat, 42.7114);
  assert.equal(meta.elevationFt, 722);
  assert.equal(meta.softwareType, 'GW1100A_V2.4.2');
});

test('an offline station reports null rather than throwing', async () => {
  process.env.WU_API_KEY = 'k';
  const { fetchCurrent } = await import('../tools/wu.mjs');
  stub({ observations: [] });
  assert.equal(await fetchCurrent(), null);
});

test('204 means an empty window, not a failure', async () => {
  process.env.WU_API_KEY = 'k';
  const { fetchHistory } = await import('../tools/wu.mjs');
  stub(null, { status: 204 });
  assert.deepEqual(await fetchHistory('20260801'), []);
});

test('a missing key fails before any request is made', async () => {
  const { fetchCurrent } = await import('../tools/wu.mjs');
  stub({ observations: [] });
  await assert.rejects(() => fetchCurrent(), /WU_API_KEY is not set/);
  assert.equal(calls.length, 0);
});

test('the API key never appears in an error message', async () => {
  process.env.WU_API_KEY = 'super-secret-key';
  const { fetchCurrent } = await import('../tools/wu.mjs');
  stub({ error: 'nope' }, { status: 401 });

  await assert.rejects(() => fetchCurrent(), (err) => {
    assert.ok(!err.message.includes('super-secret-key'), 'key leaked into the error');
    assert.match(err.message, /REDACTED/);
    return true;
  });
});

// ─────────────────────────── Xweather ───────────────────────────

const STATION = { lat: 42.7114, lon: -85.4636 };

test('xweather is preferred over a detector when both are configured', async () => {
  process.env.XWEATHER_CLIENT_ID = 'a';
  process.env.XWEATHER_CLIENT_SECRET = 'b';
  process.env.AMBIENT_APPLICATION_KEY = 'c';
  process.env.AMBIENT_API_KEY = 'd';
  const { configuredProvider, isLocatingNetwork } = await import('../tools/lightning.mjs');
  assert.equal(configuredProvider(), 'xweather');
  assert.ok(isLocatingNetwork('xweather'));
  assert.ok(!isLocatingNetwork('ambient'));
});

test('strikes parse distance, bearing and stroke type from relativeTo', async () => {
  process.env.XWEATHER_CLIENT_ID = 'a';
  process.env.XWEATHER_CLIENT_SECRET = 'b';
  const { fetchStrikes } = await import('../tools/lightning.mjs');
  stub({
    success: true,
    error: null,
    response: [{
      id: 'abc123',
      loc: { lat: 42.9, long: -85.2 },
      ob: { timestamp: 1785608400, dateTimeISO: '2026-08-01T14:20:00-04:00', type: 'CG', peakAmps: -18400 },
      relativeTo: { distanceMI: 17.42, bearing: 51, bearingENG: 'NE' },
    }],
  });

  const [strike] = await fetchStrikes(STATION, 30, 150);
  assert.equal(strike.id, 'abc123');
  assert.equal(strike.epoch, 1785608400);
  assert.equal(strike.distanceMi, 17.4);
  assert.equal(strike.bearingDeg, 51);
  assert.equal(strike.type, 'CG');
  assert.equal(strike.peakAmps, -18400);

  assert.equal(param(calls[0], 'p'), '42.7114,-85.4636');
  assert.equal(param(calls[0], 'radius'), '150mi');
  assert.equal(param(calls[0], 'from'), '-30minutes');
});

test('distance and bearing are computed when the provider omits them', async () => {
  process.env.XWEATHER_CLIENT_ID = 'a';
  process.env.XWEATHER_CLIENT_SECRET = 'b';
  const { fetchStrikes } = await import('../tools/lightning.mjs');
  // One degree of latitude due north is about 69 miles.
  stub({
    success: true,
    response: [{ id: 'x', loc: { lat: 43.7114, long: -85.4636 }, ob: { timestamp: 5 } }],
  });

  const [strike] = await fetchStrikes(STATION, 30, 150);
  assert.ok(Math.abs(strike.distanceMi - 69) < 1, `got ${strike.distanceMi} mi`);
  assert.ok(strike.bearingDeg === 0 || strike.bearingDeg === 360, `got ${strike.bearingDeg}°`);
});

test('an ISO timestamp is accepted when no epoch is given', async () => {
  process.env.XWEATHER_CLIENT_ID = 'a';
  process.env.XWEATHER_CLIENT_SECRET = 'b';
  const { fetchStrikes } = await import('../tools/lightning.mjs');
  stub({
    success: true,
    response: [{ id: 'x', loc: { lat: 42.8, long: -85.4 }, ob: { dateTimeISO: '2026-08-01T18:20:00Z' } }],
  });

  const [strike] = await fetchStrikes(STATION, 30, 150);
  assert.equal(strike.epoch, Math.round(Date.parse('2026-08-01T18:20:00Z') / 1000));
});

test('an empty search area is an empty list, not an error', async () => {
  process.env.XWEATHER_CLIENT_ID = 'a';
  process.env.XWEATHER_CLIENT_SECRET = 'b';
  const { fetchStrikes } = await import('../tools/lightning.mjs');
  stub({ success: false, error: { code: 'warn_no_data', description: 'No data was returned' } });
  assert.deepEqual(await fetchStrikes(STATION, 30, 150), []);
});

test('a real xweather error is raised, without the credentials', async () => {
  process.env.XWEATHER_CLIENT_ID = 'client-abc';
  process.env.XWEATHER_CLIENT_SECRET = 'secret-xyz';
  const { fetchStrikes } = await import('../tools/lightning.mjs');
  stub({ success: false, error: { code: 'invalid_client', description: 'bad credentials' } });

  await assert.rejects(() => fetchStrikes(STATION, 30, 150), (err) => {
    assert.match(err.message, /invalid_client/);
    assert.ok(!err.message.includes('secret-xyz'));
    return true;
  });
});

test('strikes are not fetched without station coordinates', async () => {
  process.env.XWEATHER_CLIENT_ID = 'a';
  process.env.XWEATHER_CLIENT_SECRET = 'b';
  const { fetchStrikes } = await import('../tools/lightning.mjs');
  stub({ success: true, response: [] });
  await assert.rejects(() => fetchStrikes({}, 30, 150), /coordinates unknown/);
});

// ─────────────────────────── detectors ───────────────────────────

test('ecowitt kilometres are converted to miles', async () => {
  process.env.ECOWITT_APPLICATION_KEY = 'a';
  process.env.ECOWITT_API_KEY = 'b';
  process.env.ECOWITT_MAC = 'AA:BB';
  const { fetchLightning } = await import('../tools/lightning.mjs');
  stub({
    code: 0,
    msg: 'success',
    data: {
      lightning: {
        distance: { unit: 'km', value: '16.09', time: '1785608400' },
        count: { unit: 'count', value: '14', time: '1785608400' },
      },
    },
  });

  const reading = await fetchLightning();
  assert.equal(reading.countToday, 14);
  assert.equal(reading.lastDistanceMi, 10, '16.09 km is 10 miles');
  assert.equal(reading.lastStrikeEpoch, 1785608400);
  assert.equal(reading.provider, 'ecowitt');
});

test('ecowitt miles are left alone', async () => {
  process.env.ECOWITT_APPLICATION_KEY = 'a';
  process.env.ECOWITT_API_KEY = 'b';
  process.env.ECOWITT_MAC = 'AA:BB';
  const { fetchLightning } = await import('../tools/lightning.mjs');
  stub({ code: 0, data: { lightning: { distance: { unit: 'mi', value: '7.5' }, count: { value: '3' } } } });
  assert.equal((await fetchLightning()).lastDistanceMi, 7.5);
});

test('a station with no lightning sensor reports null', async () => {
  process.env.ECOWITT_APPLICATION_KEY = 'a';
  process.env.ECOWITT_API_KEY = 'b';
  process.env.ECOWITT_MAC = 'AA:BB';
  const { fetchLightning } = await import('../tools/lightning.mjs');
  stub({ code: 0, data: { outdoor: { temperature: { value: '72' } } } });
  assert.equal(await fetchLightning(), null);
});

test('an ecowitt error code is surfaced', async () => {
  process.env.ECOWITT_APPLICATION_KEY = 'a';
  process.env.ECOWITT_API_KEY = 'b';
  process.env.ECOWITT_MAC = 'AA:BB';
  const { fetchLightning } = await import('../tools/lightning.mjs');
  stub({ code: 40010, msg: 'Illegal Application_Key Parameter' });
  await assert.rejects(() => fetchLightning(), /40010/);
});

test('ambient picks the device named by MAC, not merely the first', async () => {
  process.env.AMBIENT_APPLICATION_KEY = 'a';
  process.env.AMBIENT_API_KEY = 'b';
  process.env.AMBIENT_MAC = 'FF:EE:DD';
  const { fetchLightning } = await import('../tools/lightning.mjs');
  stub([
    { macAddress: '11:22:33', lastData: { lightning_day: 99, lightning_distance: 1 } },
    { macAddress: 'ff:ee:dd', lastData: { lightning_day: 7, lightning_distance: 12.5, lightning_time: 1785608400 } },
  ]);

  const reading = await fetchLightning();
  assert.equal(reading.countToday, 7);
  assert.equal(reading.lastDistanceMi, 12.5);
  assert.equal(reading.lastStrikeEpoch, 1785608400);
});

test('ambient millisecond timestamps are reduced to seconds', async () => {
  process.env.AMBIENT_APPLICATION_KEY = 'a';
  process.env.AMBIENT_API_KEY = 'b';
  const { fetchLightning } = await import('../tools/lightning.mjs');
  stub([{ macAddress: 'x', lastData: { lightning_day: 2, lightning_time: 1785608400000 } }]);
  assert.equal((await fetchLightning()).lastStrikeEpoch, 1785608400);
});

test('nothing configured means nothing fetched', async () => {
  const { configuredProvider, fetchLightning, fetchStrikes } = await import('../tools/lightning.mjs');
  stub({});
  assert.equal(configuredProvider(), null);
  assert.equal(await fetchLightning(), null);
  assert.deepEqual(await fetchStrikes(STATION, 30, 150), []);
  assert.equal(calls.length, 0);
});
