// Lightning detection.
//
// Weather Underground's PWS API carries no lightning fields at all, so this
// data cannot come from the same place as the observations. The source that
// actually belongs on a personal weather station dashboard is the station's own
// detector (an Ecowitt WH57 or the equivalent on an Ambient console), read from
// the vendor's cloud API.
//
// Both vendors report the same three things — a strike counter that resets at
// local midnight, the time of the most recent strike, and how far away it was —
// which is why this polls cleanly on a schedule: the counter is state, not a
// stream, so a fifteen-minute cadence loses no strikes.
//
// Configure with either set of credentials:
//
//   ECOWITT_APPLICATION_KEY, ECOWITT_API_KEY, ECOWITT_MAC
//   AMBIENT_APPLICATION_KEY, AMBIENT_API_KEY   (optional AMBIENT_MAC)

const KM_PER_MILE = 1.609344;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(...candidates) {
  for (const value of candidates) if (value !== undefined && value !== null) return value;
  return null;
}

/** Which provider the environment is configured for, if any. */
export function configuredProvider() {
  if (process.env.ECOWITT_APPLICATION_KEY && process.env.ECOWITT_API_KEY && process.env.ECOWITT_MAC) {
    return 'ecowitt';
  }
  if (process.env.AMBIENT_APPLICATION_KEY && process.env.AMBIENT_API_KEY) return 'ambient';
  return null;
}

function safeUrl(url) {
  const clone = new URL(url);
  for (const key of ['api_key', 'application_key', 'apiKey', 'applicationKey']) {
    if (clone.searchParams.has(key)) clone.searchParams.set(key, 'REDACTED');
  }
  return clone.toString();
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`request to ${safeUrl(url)} failed: ${err.message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${res.status} ${res.statusText} from ${safeUrl(url)} ${body}`);
  }
  return res.json();
}

/** Distance to miles, whatever unit the vendor decided to answer in. */
function toMiles(value, unit) {
  const miles = num(value);
  if (miles === null) return null;
  return /km/i.test(unit || '') ? Math.round((miles / KM_PER_MILE) * 10) / 10 : miles;
}

// ─────────────────────────── Ecowitt ───────────────────────────

async function fetchEcowitt() {
  const url = new URL('https://api.ecowitt.net/api/v3/device/real_time');
  url.searchParams.set('application_key', process.env.ECOWITT_APPLICATION_KEY);
  url.searchParams.set('api_key', process.env.ECOWITT_API_KEY);
  url.searchParams.set('mac', process.env.ECOWITT_MAC);
  url.searchParams.set('call_back', 'lightning');

  const body = await getJson(url);
  if (Number(body.code) !== 0) {
    throw new Error(`ecowitt returned code ${body.code}: ${body.msg || 'no message'}`);
  }

  // Shape: data.lightning.{distance,count}.{value,unit,time}. Absent entirely
  // when the account has no lightning sensor paired.
  const lightning = body.data?.lightning;
  if (!lightning) return null;

  const count = lightning.count || lightning.lightning_num || {};
  const distance = lightning.distance || lightning.lightning || {};

  return {
    countToday: num(pick(count.value, count)),
    lastDistanceMi: toMiles(pick(distance.value, distance), distance.unit),
    // Ecowitt stamps each field with the time it last changed, which for the
    // distance reading is exactly the moment of the last detected strike.
    lastStrikeEpoch: num(pick(distance.time, count.time)),
  };
}

// ─────────────────────────── Ambient Weather ───────────────────────────

async function fetchAmbient() {
  const url = new URL('https://rt.ambientweather.net/v1/devices');
  url.searchParams.set('applicationKey', process.env.AMBIENT_APPLICATION_KEY);
  url.searchParams.set('apiKey', process.env.AMBIENT_API_KEY);

  const devices = await getJson(url);
  if (!Array.isArray(devices) || !devices.length) return null;

  const wanted = process.env.AMBIENT_MAC;
  const device = wanted
    ? devices.find((d) => d.macAddress?.toLowerCase() === wanted.toLowerCase())
    : devices[0];
  const data = device?.lastData;
  if (!data) return null;

  const strikes = num(pick(data.lightning_day, data.lightningday));
  if (strikes === null && data.lightning_distance === undefined) return null;

  return {
    countToday: strikes,
    // Ambient reports distance in miles on imperial accounts.
    lastDistanceMi: num(pick(data.lightning_distance, data.lightningdistance)),
    lastStrikeEpoch: (() => {
      const raw = pick(data.lightning_time, data.lastLightning);
      if (raw === null) return null;
      const value = num(raw);
      if (value !== null) return value > 1e11 ? Math.round(value / 1000) : value;
      const parsed = Date.parse(raw);
      return Number.isNaN(parsed) ? null : Math.round(parsed / 1000);
    })(),
  };
}

/**
 * Current lightning state, or null when no provider is configured or the
 * account has no detector paired.
 *
 * @returns {Promise<{epoch:number, countToday:number|null,
 *                    lastStrikeEpoch:number|null, lastDistanceMi:number|null,
 *                    provider:string}|null>}
 */
export async function fetchLightning() {
  const provider = configuredProvider();
  if (!provider) return null;

  const reading = provider === 'ecowitt' ? await fetchEcowitt() : await fetchAmbient();
  if (!reading) return null;

  return {
    epoch: Math.floor(Date.now() / 1000),
    provider,
    countToday: reading.countToday,
    lastStrikeEpoch: reading.lastStrikeEpoch,
    lastDistanceMi: reading.lastDistanceMi,
  };
}
