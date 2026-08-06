# YMCA Camp Manitou-Lin — weather archive & dashboard

Archives the observations from PWS **KMIMIDDL77** into this repository and
renders them as a static dashboard. No dependencies, no build step, no server —
the archiver is plain Node, the dashboard is plain HTML/CSS/JS reading committed
JSON.

The dashboard is built for a **wall-mounted screen in the camp office**: at
1080p or 1440p it fills exactly one viewport with nothing below the fold and
nothing behind a scrollbar, type is sized to read from across the room, and it
refreshes itself every five minutes because nobody is going to walk over and
press F5. Below 1280px it falls back to an ordinary scrolling page for phones
and desks.

It follows the **YMCA of the USA Brand Graphics Guide** — see
[Brand compliance](#brand-compliance), and read `assets/README.md` before first
deploy, because the Y logo is not in this repository and has to be added.

The point of the archiver is ownership: Weather Underground's history API is
fine for recent dates, but an archive in the repo is permanent, queryable and
outlives whatever the API does next. Everything else — records, alerts, forecast
scoring — builds on it.

`index.html` sits at the repository root, so **GitHub Pages serves the dashboard
with no configuration**: Settings → Pages → deploy from the default branch, and
the archive the workflow commits is what the page reads.

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

## Check it works first

Nothing here was written against a live payload — the field mappings come from
documented response shapes. The interesting failure is therefore not "the
request failed" but "the request succeeded and we read the wrong field names",
which looks like a dashboard full of dashes rather than an error.

`doctor.mjs` calls each configured API and reports, field by field, what
actually came back:

```bash
WU_API_KEY=… node tools/doctor.mjs
```

```
Weather Underground
  ok    current conditions: 72.2°F, 0 min old
  ok    all core fields mapped: epoch, tempF, dewptF, humidity, windMph, …
  ok    optional sensors: heatIndexF, windChillF, gustMph, windDir, solarWm2, uv
  ok    rapid history: 288 observations in the last 24 hours
  FAIL  every rapid-history record has a null temperature — aggregate field names are wrong
```

It exits non-zero on failure, so it can gate a first deploy. Run it before
trusting anything else in this directory.

## Tests

```bash
node --test "tests/*.test.mjs"
```

No dependencies and no install — the runner is built into Node. The suite covers
the parts that are easy to get quietly wrong: the normaliser against both
endpoint spellings, the daily rollups (including the counter-reset and
accumulator traps), the sun maths against known solstice and equinox values, and
every provider parser against stubbed payloads — that last group being the
record of what we currently believe each API returns. **When a live run
disagrees with one of those fixtures, fix the fixture and the parser together.**

CI runs them on every push.

## Commands

```bash
# Pull the last 24 hours at full resolution and merge into the archive
node tools/archive.mjs

# Seed history that predates the archive (one API call per day, paced)
node tools/backfill.mjs --days 30
node tools/backfill.mjs --from 2025-06-01 --to 2025-08-31

# View the dashboard (fetch() needs http://, so file:// won't work)
python3 -m http.server 8000    # then open http://localhost:8000/

# Build one self-contained file — markup, styles, scripts and data inlined
node tools/build-single.mjs             # last 7 days at full resolution
node tools/build-single.mjs --days 30
node tools/build-single.mjs --out ~/station.html
```

The single-file build lands in `dist/` (gitignored) and needs no server —
open it straight from disk, put it on a USB stick, mail it to someone. Markup,
styles, scripts, the archive, the brand tokens and the Y logo are all inlined,
so every reading and every colour is self-contained. Every day's *summary*
always rides along, so the long ranges work in full; `--days` controls how much
full-resolution observation data comes with it, which is what drives the file
size (roughly 80 KB per day).

The one thing it cannot carry offline is **radar**, which is fetched live by
definition. With no internet the radar panel shows its "unavailable" message and
everything else works normally.

`WU_STATION_ID` overrides the station if you ever point this at another one.

## The scheduled archive

`.github/workflows/archive.yml` runs `archive.mjs` every 5 minutes and
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

## Freshness

**Read the `*/5` schedule as a best case, not a promise.**

Four clocks sit between the station and the screen:

| | |
|---|---|
| Archiver commits new readings | every 5 min, *if GitHub runs it* |
| Page re-reads the archive | every 1 min |
| Radar re-fetches frames | every 5 min |
| Age label re-ticks | every 30 s, even offline |

So when everything works, the readings are a few minutes old and the page is
never more than a minute behind the archive. Radar is fresher than the
readings, because it comes straight from RainViewer rather than through the
archive — which is the right way round for the thing you would actually act on.

The catch is the first row. GitHub queues scheduled workflows on a best-effort
basis, deprioritises frequent ones, and drops them under load. **On this repo a
`*/15` schedule fired exactly once in its first eight hours**; every other
archive run in that period was triggered by hand. Nothing is wrong with the
workflow when this happens, and nothing in this repository can fix it.

The design absorbs missed runs — each one re-pulls a 24-hour window — so a gap
costs no data, only currency. But if the screen must be *reliably* current
rather than usually current, the trigger has to live somewhere with a real
scheduler: a machine at camp running `node tools/archive.mjs` on a timer and
pushing, or an external cron calling the `workflow_dispatch` API. Either
removes GitHub's scheduler from the critical path.

Because none of that can be guaranteed, the dashboard never claims to be
current when it isn't. Past 20 minutes the status chip turns amber and states
the actual age; past 90 minutes it turns red and pulses. It stays quiet while
things are fine, so that a loud chip means something. The age is driven by its
own 30-second timer rather than by the data fetch, so it keeps climbing even
when the page cannot reach GitHub at all — a frozen "2 min ago" would be the
one genuinely dangerous thing this screen could show.

## The camp poller

`tools/poller.mjs` is the way off GitHub's scheduler. It is an ordinary
long-running Node process for a machine that is already on at camp — the box
driving the screen is ideal — with a real timer instead of a best-effort queue.

```bash
WU_API_KEY=… node tools/poller.mjs --interval 3 --serve
```

That polls every 3 minutes, commits and pushes the archive, **and** serves the
dashboard on `http://localhost:8000/`.

### Point the screen at the poller, not at Pages

`--serve` is the part that actually buys the freshness. With the screen on
`localhost`, the whole GitHub round trip leaves the critical path — no commit
wait, no Pages build, no CDN — and the display shows a reading within seconds
of the poll that fetched it. The push still happens, so the permanent archive
and the public Pages site stay current; they are just no longer what the wall
depends on.

Radar still comes from the internet either way.

### One writer

**Turn off the Actions schedule when you run the poller.** Comment out the
`schedule:` block in `.github/workflows/archive.yml`, or disable the workflow in
the Actions tab. Two processes committing to `data/` will collide, and while the
poller recovers from that (it rebases, and rebuilds from origin next cycle if
the rebase conflicts), there is no reason to make it work for a living. Keep
`workflow_dispatch` so you can still backfill from the web UI.

### It treats origin as the source of truth

Before each poll the process runs `git reset --hard origin/<branch>`. That is
deliberate: it means the poller can never diverge from the remote, which is what
keeps the push path simple enough to trust unattended. The archiver re-pulls a
full 24-hour window every run, so discarding local `data/` costs nothing recent.

The consequence is that **this checkout is a deployment, not a working copy**.
Anything you edit there and do not commit will be discarded. The poller refuses
to run and says so if it finds uncommitted changes outside `data/`, so this
cannot bite you silently — but do your editing somewhere else.

### Running it as a service

**Windows** — Task Scheduler, which is what the camp office box runs.

1. Create Task → **Run whether user is logged on or not**, **Run with highest
   privileges** unchecked.
2. Triggers → New → **At startup**. Tick **Repeat task every 5 minutes** for
   **Indefinitely** as a watchdog — the process is meant to stay up, and this
   restarts it if it ever dies.
3. Actions → New → Start a program:
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `tools\poller.mjs --interval 3 --serve`
   - Start in: the repository folder
4. Settings → untick **Stop the task if it runs longer than**, and set
   **If the task is already running** to **Do not start a new instance**.

Put `WU_API_KEY` (and the Xweather pair, if used) in the machine's environment
variables, not on the command line — Task Scheduler arguments are readable by
anyone who can open the task.

**Linux / macOS** — systemd, or `launchd` with `KeepAlive`:

```ini
# /etc/systemd/system/weather-poller.service
[Service]
WorkingDirectory=/opt/weathermanitou
Environment=WU_API_KEY=…
ExecStart=/usr/bin/node tools/poller.mjs --interval 3 --serve
Restart=always
RestartSec=30
[Install]
WantedBy=multi-user.target
```

### Options

| | |
|---|---|
| `--interval N` | minutes between polls (default 3) |
| `--serve` | serve the dashboard over HTTP as well |
| `--port N` | port for `--serve` (default 8000) |
| `--no-push` | archive locally and never push; only sensible with `--serve` |
| `--once` | one cycle, then exit — for checking the setup |

Start with `--once` to prove the credentials and the git remote work before
handing it to a scheduler.

### Git credentials

The poller pushes, so the machine needs a credential that can write to the
repository. A [fine-grained personal access token](https://github.com/settings/tokens?type=beta)
scoped to this one repository with **Contents: read and write** is the smallest
thing that works; store it with `git config credential.helper` rather than in
the remote URL, so it does not end up in `git remote -v` output.

A failed push is not data loss — the archive is rebuilt from WU on the next
cycle — but it does mean the public Pages site stops updating while the
`--serve` screen carries on, which is a divergence worth noticing.

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
node tools/lightning-archive.mjs --radius 150 --minutes 30
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
data/
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

`index.html`. The layout has one rule: **everything above the range
filter describes now, everything below it describes the selected range.** So the
numbers on screen always agree with each other.

The screen is three panels over a row of charts.

**Now** (left) — the current temperature as the hero figure, with apparent
temperature and the change over the last hour; today's high, low and peak gust
each with the time they happened; sunrise, sunset and daylight length computed
from the station's own coordinates. Then dew point, humidity, wind and gust,
each with the current value, today's range for context, and a 24-hour sparkline.
A status dot reports live, delayed or offline from the age of the newest
observation.

**Radar** (centre) — see [Radar](#radar).

**Lightning** (right) — see [The lightning panel](#the-lightning-panel).

**The selected range** (bottom) — six charts: temperature (with dew point, and
apparent temperature drawn only across the stretches where it actually differs
from the reading), relative humidity, wind speed, a 16-sector wind rose binned
by speed, precipitation and UV index. On narrower screens a panel of range
extremes and the full data table follow below; both are hidden on the TV, where
the screen is for glancing at rather than reading.

**Barometric pressure and solar radiation are not displayed.** Neither changes
a decision anyone makes at camp, and the space is worth more to radar and
lightning. Both are still archived and still in the daily rollups — only the
display is narrower, so putting either card back is a markup change, not a data
migration.

Ranges up to 7 days draw the full-resolution observations; longer ranges switch
to the daily rollups, because 90 days of five-minute samples is ~26,000 points
fighting over 600 pixels. Nothing is dropped in the switch: the rollups carry
every field the high-resolution view shows, including the wind rose and the
timestamps of each day's extremes.

Charts are hand-rolled SVG — a crosshair tooltip listing every series, the same
readout on keyboard focus via arrow keys, direct end labels and a data table
twin. Colour follows the Y data-visualization standard: one colour family per
chart rather than a categorical palette (see below).

UV and lightning disappear by themselves on a station that doesn't report them,
rather than showing a row of dashes.

## The lightning panel

A permanent panel, always on screen whether or not anything is happening: the
**five most recent strikes within 25 miles**, each with how long ago it hit, how
far away it was and which way. Above them, the count in the last hour — the
number that decides whether the waterfront stays open — which turns green at
zero. With no strikes archived in range it reads **All clear** rather than
sitting empty, because a blank panel on a wall is ambiguous and "all clear" is
not.

Ages re-render every 30 seconds, so "4 min ago" stays true between data
refreshes.

Distances are recomputed in the browser from each strike's own coordinates
rather than read from the archived `distanceMi`, which is measured from the
weather station at archive time. That matters if you move the reference point:

```js
// js/app.js
const CAMP = {
  lat: null,      // null → use the station's own reported position
  lon: null,
  radiusMi: 25,
  strikeCount: 5,
};
```

It ships as `null`, meaning the station's own coordinates, so the panel and the
archive agree by construction. Set `lat`/`lon` to pin it to the camp office at
1095 N Briggs Rd if the station sits elsewhere on the property; a bare detector
that reports a distance and no position still works, it just has no bearing to
show. The maths is covered in `tests/strikes.test.mjs`.

## Radar

Camp-centred, animated, from [RainViewer](https://www.rainviewer.com/) — free,
no API key, so nothing secret ends up in the page. Radar tiles are composited
over a muted CARTO basemap onto a canvas, ringed at the 25-mile radius, with the
Y triangle marking camp; the guide names the triangle as a map pointer, so it is
doing a job the brand already sanctions (p26). The last ~50 minutes of frames
animate on a loop, which is the part a still image cannot give you: whether a
cell is heading at camp or away from it.

Two hosts have to be reachable from wherever the screen lives:

```
api.rainviewer.com        frame index
basemaps.cartocdn.com     basemap tiles
```

If either is blocked the panel says so in words, naming the host. That is
deliberate — **a blank radar on a camp wall reads as clear skies**, which is the
worst thing it could do. The archived readings are unaffected either way.

## Brand compliance

Built to the YMCA of the USA Brand Graphics Guide (452562 1/26).

- **Colour** — `css/brand.css` transcribes the full main palette: five families
  of three shades, plus gray, black and white, with the CMYK/RGB/hex/PMS values
  from p18. Nothing outside that palette appears anywhere. Charts follow the
  data-visualization rule of one colour family per chart (p28) rather than a
  categorical palette — temperature is the red family, humidity and rain blue,
  wind green, UV orange. The wind rose needs five ordered bins where a family
  has three shades, so it uses an ordinal ramp anchored on the blue family's
  light and dark ends.
- **Type** — Cachet Pro leads the stack, but it is licensed through the Brand
  Resource Center and is not committed here. The guide names **Verdana** for
  "online applications ... websites and email" (p19), so that is the compliant
  default and what actually renders. License Cachet Pro as a webfont and it wins
  automatically.
- **Logo** — not in this repository, and it cannot be generated. See
  `assets/README.md`. Until the file is added the header shows a red dashed
  marker rather than a silent gap. The brand bar stays **white in both themes**,
  because the full-colour logo may only appear on white (p11).
- **Clear space** — enforced in CSS from the height of the word "the", per p13.
- **Areas of impact** — present in the header as copy, which is one of the two
  forms p32 permits on a website.

One knowing departure: p13 asks for **double** clear space between the logo and
an association name. This ships at single, at the camp's request, because the
doubled gap looked wrong with the name set directly beneath the mark. It is one
variable — `--logo-name-gap` in `css/dashboard.css` — so a brand review can undo
it in one line.

Before linking this anywhere outside camp, note that p32 asks you to email
theYbrand@ymca.net prior to launch if a site will be used beyond the
association's immediate service area. GitHub Pages is public.

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
