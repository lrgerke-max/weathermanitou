# Weather station archive & dashboard

Archives the observations from PWS **KMIMIDDL77** into this repository and
renders them as a static dashboard. No dependencies, no build step, no server —
the archiver is plain Node, the dashboard is plain HTML/CSS/JS reading committed
JSON.

The point of the archiver is ownership: Weather Underground's history API is
fine for recent dates, but an archive in the repo is permanent, queryable and
outlives whatever the API does next. Everything else — records, alerts, forecast
scoring — builds on it.

## Setup

Weather Underground issues free API keys to people whose station is registered
and actively uploading. Get yours at
<https://www.wunderground.com/member/api-keys>.

The key is read from `WU_API_KEY` and is never written to a file:

```bash
export WU_API_KEY=your-key-here
```

For the scheduled archive, add it as a repository secret named `WU_API_KEY`
under **Settings → Secrets and variables → Actions**.

## Commands

```bash
# Pull the last 24 hours at full resolution and merge into the archive
node weather/tools/archive.mjs

# Seed history that predates the archive (one API call per day, paced)
node weather/tools/backfill.mjs --days 30
node weather/tools/backfill.mjs --from 2025-06-01 --to 2025-08-31

# View the dashboard (fetch() needs http://, so file:// won't work)
python3 -m http.server 8000    # then open http://localhost:8000/weather/

# Build one self-contained file — markup, styles, scripts and data inlined
node weather/tools/build-single.mjs             # last 7 days at full resolution
node weather/tools/build-single.mjs --days 30
node weather/tools/build-single.mjs --out ~/station.html
```

The single-file build lands in `weather/dist/` (gitignored) and needs no server
and no network — open it straight from disk, put it on a USB stick, mail it to
someone. Every day's *summary* always rides along, so the long ranges work in
full; `--days` controls how much full-resolution observation data comes with it,
which is what drives the file size (roughly 80 KB per day).

`WU_STATION_ID` overrides the station if you ever point this at another one.

## The scheduled archive

`.github/workflows/weather-archive.yml` runs `archive.mjs` every 15 minutes and
commits whatever is new. Each run re-pulls the whole last 24 hours and merges by
timestamp, so overlapping runs are harmless and a run GitHub drops under load
costs nothing — the next one catches up.

Two things to know:

- GitHub only fires `schedule` triggers from the **default branch**. On a
  feature branch the workflow exists but never runs on its own; use the
  **Run workflow** button (`workflow_dispatch`), which also takes a
  `backfill_days` input.
- Scheduled runs are best-effort and often late by several minutes. That's fine
  here, and it's why the archiver pulls a window rather than a single reading.

## Lightning

Weather Underground's PWS API carries **no lightning fields at all**, so this
cannot come from the same place as the observations. Where it comes from
instead, and why:

| Source | Verdict |
|---|---|
| **[Xweather](https://www.xweather.com/products/weather-api/lightning)** (Vaisala) `lightning/closest` | **What this uses.** Vaisala runs the network the US lightning industry is built on, and the [free tier](https://www.xweather.com/products/weather-api) covers every endpoint at 15,000 accesses/month — a 15-minute poll spends about 2,900. Returns *individual strikes* with coordinates, so distance, bearing and cloud-to-ground vs intracloud are all real. |
| **[GOES-19 GLM](https://catalog.data.gov/dataset/noaa-goes-r-series-geostationary-lightning-mapper-glm-level-2-lightning-detection-events-groups3)** (satellite) on the NOAA AWS open bucket | The best *unencumbered* option: public domain, no key, no quota, 30–60 s latency. Rejected for now on cost of machinery, not quality — it is netCDF4/HDF5 every 20 seconds, roughly 9 MB per 15-minute window to download and parse, with coarser geolocation than a ground network. The right answer if the Xweather quota or terms ever stop working; see `lightning.mjs` for where a provider slots in. |
| [Blitzortung](https://www.blitzortung.org/) / lightningmaps | Free, superb coverage, and the one everyone reaches for — but its [terms](https://docs.lightningmaps.org/) restrict use to project participants, forbid storm-warning use outright, and require third-party apps to serve data from their own servers rather than connecting to Blitzortung's. Not something to ship. |
| **A local detector** (Ecowitt WH57, Ambient console) | Supported, and preferred over nothing, but it reports only a counter, the last strike's distance, and when — no coordinates, so no direction. Used automatically if configured and no network is. |
| AccuWeather, Earth Networks, NLDN direct | Commercial licensing. |

Sign up at [Xweather's free developer tier](https://signup.xweather.com/developer)
and configure:

```bash
export XWEATHER_CLIENT_ID=… XWEATHER_CLIENT_SECRET=…
node weather/tools/lightning-archive.mjs --radius 150 --minutes 30
```

Or, for a station that has its own detector instead:

```bash
export ECOWITT_APPLICATION_KEY=… ECOWITT_API_KEY=… ECOWITT_MAC=…
# or
export AMBIENT_APPLICATION_KEY=… AMBIENT_API_KEY=…   # AMBIENT_MAC optional
```

Add the same names as repository secrets for the scheduled workflow. A locating
network wins when both are configured — it is a superset of what a local
detector can tell you.

Each run asks for everything since the last strike already archived, plus a
minute of overlap, and strikes merge on the provider's strike ID: re-seeing a
strike is free, missing one is not. A run after a long gap is capped at six
hours so it can't ask for a week at once.

Days carry a **direction rose** (16 sectors × distance band) in the rollups, so
strike direction survives the switch to long ranges without loading a season of
individual strikes — the same trick the wind rose uses.

## Data layout

```
weather/data/
  obs/YYYY-MM-DD.json   every observation for one station-local day
  daily.json            one rollup row per day — drives the long-range charts
  latest.json           newest observation, today's rollup, station description
  index.json            which days exist, for the dashboard to discover
  lightning/            the same four shapes, from the detector (see above)
```

Lightning lives in its own tree because it comes from a different provider on a
different cadence: the observation archive must not gain or lose days depending
on whether a detector happens to be configured.

Observations are normalised to one flat record shape regardless of which
endpoint they came from, in imperial units (°F, mph, inHg, in, W/m²):

```json
{
  "epoch": 1785000000, "ts": "2026-08-01T18:20:00Z", "local": "2026-08-01 14:20:00",
  "tempF": 72.2, "dewptF": 62.3, "heatIndexF": 74.1, "windChillF": 72.2,
  "humidity": 71, "windDir": 210, "windMph": 5.0, "gustMph": 9.0,
  "pressureIn": 29.92, "precipRateIn": 0.0, "precipTotalIn": 0.0,
  "solarWm2": 640, "uv": 5
}
```

Missing sensors come through as `null` rather than zero, so a station without a
solar/UV or lightning sensor simply has empty columns instead of fake readings.

Days are bucketed by **station-local** date, matching how `precipTotal` resets at
local midnight — which is also why a day's rainfall is the high-water mark of
that accumulator, not a sum of the samples.

Each row in `daily.json` also carries the time of that day's temperature and
gust extremes, and a `rose` object — 16 compass sectors × 5 speed bins — so the
wind rose works across a season without loading a season of raw observations.

## Dashboard

`weather/index.html`. The layout has one rule: **everything above the range
filter describes now, everything below it describes the selected range.** So the
numbers on screen always agree with each other.

**Now** — the current temperature as the hero figure, with apparent temperature
and the change over the last hour; today's high, low and peak gust each with the
time they happened; sunrise, sunset and daylight length computed from the
station's own coordinates. Then a rail of every live reading — dew point,
humidity, wind, gust, pressure, rain, solar, UV — each showing the current value,
today's range for context, and a 24-hour sparkline. A status dot reports live,
delayed or offline from the age of the newest observation.

**The selected range** — eight charts: temperature (with dew point, and apparent
temperature drawn only across the stretches where it actually differs from the
reading), relative humidity, wind speed, a 16-sector wind rose binned by speed,
barometric pressure, precipitation, solar radiation and UV index. Below them, a
panel of range extremes — each with the moment it happened — and the full data
table.

Ranges up to 7 days draw the full-resolution observations; longer ranges switch
to the daily rollups, because 90 days of five-minute samples is ~26,000 points
fighting over 600 pixels. Nothing is dropped in the switch: the rollups carry
every field the high-resolution view shows, including the wind rose and the
timestamps of each day's extremes.

Charts are hand-rolled SVG — a crosshair tooltip listing every series, the same
readout on keyboard focus via arrow keys, direct end labels, a data table twin,
and a light/dark palette validated for colour-vision deficiency (categorical
slots for the multi-series charts, an ordinal one-hue ramp for the rose's speed
bins).

Two more cards appear when lightning is being archived: **Lightning** (strikes
per hour or per day) and **Strike direction** (a rose of located strikes, binned
by distance). Plus a rail cell with today's count and the last strike's distance
and bearing, and closest-strike, total and cloud-to-ground entries in the
extremes panel. The direction rose needs located strikes; a bare detector has no
direction to plot, so that card stays hidden.

Solar, UV and lightning disappear by themselves on a station that doesn't report
them, rather than showing a row of dashes.

## Ideas this sets up

- **Records & climatology** — all-time highs and lows, streaks, growing and
  heating/cooling degree days, first and last frost.
- **Alerts** — frost warning, gust threshold, rain rate, from the same schedule.
- **Forecast scoring** — log the NWS forecast (`api.weather.gov`, free, no key)
  and score it against what the station actually recorded.
- **Microclimate delta** — compare against nearby PWSs and the Grand Rapids
  ASOS; a sudden shift in the delta is sensor drift.
- **Station health** — offline detection, stuck sensors, a rain gauge reporting
  zero while neighbours report rain.
