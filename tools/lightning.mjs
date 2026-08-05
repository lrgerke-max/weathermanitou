// Lightning detection.
//
// Weather Underground's PWS API carries no lightning fields, so this cannot
// come from the same place as the observations. Two kinds of source exist, and
// this supports both:
//
//   1. A locating network — reports individual strikes with coordinates, so
//      distance, bearing and cloud-to-ground vs intracloud are all real. This
//      is the better data and the default.
//   2. The station's own detector (Ecowitt WH57 / Ambient console) — reports a
//      strike counter, the time of the last strike and its distance. No
//      coordinates, so no bearing and no map.
//
// Configure whichever applies; the archiver picks the richest one available:
//
//   XWEATHER_CLIENT_ID, XWEATHER_CLIENT_SECRET
//   ECOWITT_APPLICATION_KEY, ECOWITT_API_KEY, ECOWITT_MAC
//   AMBIENT_APPLICATION_KEY, AMBIENT_API_KEY   (optional AMBIENT_MAC)

const KM_PER_MILE = 1.609344;
const EARTH_RADIUS_MI = 3958.7613;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(...candidates) {
  for (const value of candidates) if (value !== undefined && value !== null) return value;
  return null;
}

/**
 * Which provider to use. A locating network wins when both are configured: it
 * is a superset of what a local detector can tell you.
 */
export function configuredProvider() {
  if (process.env.XWEATHER_CLIENT_ID && process.env.XWEATHER_CLIENT_SECRET) return 'xweather';
  if (process.env.ECOWITT_APPLICATION_KEY && process.env.ECOWITT_API_KEY && process.env.ECOWITT_MAC) {
    return 'ecowitt';
  }
  if (process.env.AMBIENT_APPLICATION_KEY && process.env.AMBIENT_API_KEY) return 'ambient';
  return null;
}

/** Providers that report individual strikes rather than a counter. */
export const isLocatingNetwork = (provider) => provider === 'xweather';

const SECRET_PARAMS = ['api_key', 'application_key', 'apiKey', 'applicationKey',
                       'client_id', 'client_secret'];

function safeUrl(url) {
  const clone = new URL(url);
  for (const key of SECRET_PARAMS) {
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

/** Great-circle distance in miles, for providers that don't do the maths for us. */
function haversineMi(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees from the station to the strike. */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ─────────────────────────── Xweather (Vaisala) ───────────────────────────

/**
 * Strikes near the station over a time window.
 *
 * The window is explicit rather than "whatever is current": a scheduled run can
 * be late or skipped, so each run asks for everything since a little before the
 * last strike already archived, and duplicates are dropped on ID at merge time.
 *
 * @param {{lat:number, lon:number}} station
 * @param {number} minutes  how far back to ask for
 * @param {number} radiusMi search radius
 */
async function fetchXweather(station, minutes, radiusMi) {
  const url = new URL('https://data.api.xweather.com/lightning/closest');
  url.searchParams.set('p', `${station.lat},${station.lon}`);
  url.searchParams.set('radius', `${Math.round(radiusMi)}mi`);
  url.searchParams.set('limit', '1000');
  url.searchParams.set('from', `-${Math.round(minutes)}minutes`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('client_id', process.env.XWEATHER_CLIENT_ID);
  url.searchParams.set('client_secret', process.env.XWEATHER_CLIENT_SECRET);

  const body = await getJson(url);
  if (body.success === false) {
    const code = body.error?.code || 'unknown';
    // An empty search area is reported as an error, not an empty list.
    if (/warn_no_data|no data/i.test(code)) return [];
    throw new Error(`xweather error ${code}: ${body.error?.description || ''}`);
  }

  const rows = Array.isArray(body.response) ? body.response : [];
  return rows.map((row) => {
    const ob = row.ob || row;
    const loc = row.loc || ob.loc || {};
    const relative = row.relativeTo || {};

    const lat = num(pick(loc.lat, loc.latitude));
    const lon = num(pick(loc.long, loc.lon, loc.longitude));
    const distance = num(pick(relative.distanceMI, relative.distanceMi));
    const bearing = num(relative.bearing);

    return {
      id: String(pick(row.id, ob.id, `${ob.timestamp}-${lat}-${lon}`)),
      epoch: (() => {
        const stamp = num(pick(ob.timestamp, row.timestamp));
        if (stamp !== null) return stamp;
        const parsed = Date.parse(ob.dateTimeISO || row.dateTimeISO || '');
        return Number.isNaN(parsed) ? null : Math.round(parsed / 1000);
      })(),
      lat,
      lon,
      distanceMi: distance !== null ? Math.round(distance * 10) / 10
        : (lat !== null && lon !== null
          ? Math.round(haversineMi(station.lat, station.lon, lat, lon) * 10) / 10
          : null),
      bearingDeg: bearing !== null ? Math.round(bearing)
        : (lat !== null && lon !== null
          ? Math.round(bearingDeg(station.lat, station.lon, lat, lon))
          : null),
      // "CG" cloud-to-ground vs "IC" intracloud — only the first kind hits anything.
      type: pick(ob.type, row.type),
      peakAmps: num(pick(ob.peakAmps, row.peakAmps)),
    };
  }).filter((strike) => strike.epoch !== null);
}

// ─────────────────────────── Ecowitt ───────────────────────────

/** Distance to miles, whatever unit the vendor decided to answer in. */
function toMiles(value, unit) {
  const distance = num(value);
  if (distance === null) return null;
  return /km/i.test(unit || '') ? Math.round((distance / KM_PER_MILE) * 10) / 10 : distance;
}

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
    // distance reading is the moment of the last detected strike.
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

// ─────────────────────────── entry points ───────────────────────────

/**
 * Individual strikes near the station. Locating networks only.
 * @returns {Promise<Array>} possibly empty; never null
 */
export async function fetchStrikes(station, minutes, radiusMi) {
  if (configuredProvider() !== 'xweather') return [];
  if (!Number.isFinite(station?.lat) || !Number.isFinite(station?.lon)) {
    throw new Error('station coordinates unknown — run tools/archive.mjs first');
  }
  return fetchXweather(station, minutes, radiusMi);
}

/**
 * Current counter state from a local detector, or null when the configured
 * provider is a locating network or no detector is paired.
 */
export async function fetchLightning() {
  const provider = configuredProvider();
  if (!provider || isLocatingNetwork(provider)) return null;

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
