// Sunrise, sunset and solar noon from the station's own coordinates.
//
// The standard NOAA/Astronomical Almanac approximation — good to about a
// minute, which is far better than this dashboard needs, and it costs no
// network call: the station reports its latitude and longitude, so the sun
// times come for free.

const rad = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = rad * 23.4397;
const J0 = 0.0009;

// Sunrise/sunset are defined at the moment the sun's upper limb touches the
// horizon — 0.833° below centre, once refraction and the solar radius are in.
const HORIZON = rad * -0.833;

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = (date) => toJulian(date) - J2000;

const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M) {
  const centre = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const perihelion = rad * 102.9372;
  return M + centre + perihelion + Math.PI;
}

const declination = (L) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransit = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

const hourAngle = (h, phi, dec) => Math.acos(
  (Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))
);

/**
 * @returns {{sunrise: Date, sunset: Date, noon: Date, daylightMinutes: number}|null}
 *          null inside the polar day or night, where there is no rise or set.
 */
export function sunTimes(date, lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toDays(date);

  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);

  const noon = solarTransit(ds, M, L);
  const H = hourAngle(HORIZON, phi, dec);
  if (Number.isNaN(H)) return null;

  const set = solarTransit(approxTransit(H, lw, n), M, L);
  const rise = noon - (set - noon);

  return {
    sunrise: fromJulian(rise),
    sunset: fromJulian(set),
    noon: fromJulian(noon),
    daylightMinutes: Math.round((set - rise) * 24 * 60),
  };
}
