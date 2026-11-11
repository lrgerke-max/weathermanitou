# CLAUDE.md

Guidance for AI assistants working in this repository. `README.md` is the
operator's manual (setup, deployment, brand rationale); this file is the
map for changing the code without breaking it quietly.

## What this is

A weather archive and dashboard for YMCA Camp Manitou-Lin, sourced from PWS
**KMIMIDDL77**. Plain Node archives observations into committed JSON; plain
HTML/CSS/JS renders them. The dashboard is built for a **wall-mounted screen in
the camp office**, so most of the unusual decisions here follow from one fact:
nobody is standing in front of it, and nobody will reload it.

**Zero dependencies. No package.json. No build step. No server.** `index.html`
sits at the repository root so GitHub Pages serves it with no configuration.
Node 18+ built-in `fetch`, ES modules everywhere, `node --test` for tests.
Do not introduce a package manifest, a bundler, or an npm dependency — several
things in here exist specifically to avoid needing one (`tools/build-single.mjs`
is a 90-line bundler; `js/charts.js` is hand-rolled SVG).

## Commands

```bash
node --test "tests/*.test.mjs"       # the whole suite; needs Node 22 (see gotchas)
node --check tools/foo.mjs           # syntax gate CI applies to every tools/*.mjs and js/*.js

WU_API_KEY=… node tools/doctor.mjs   # preflight: calls each API, reports field-by-field
WU_API_KEY=… node tools/archive.mjs  # pull last 24h, merge into data/
WU_API_KEY=… node tools/backfill.mjs --days 30
WU_API_KEY=… node tools/backfill.mjs --from 2025-06-01 --to 2025-08-31
XWEATHER_CLIENT_ID=… XWEATHER_CLIENT_SECRET=… node tools/lightning-archive.mjs

python3 -m http.server 8000          # view the dashboard; fetch() needs http://, not file://
node tools/build-single.mjs          # one self-contained HTML file into dist/ (gitignored)

WU_API_KEY=… node tools/poller.mjs --once            # prove the setup
WU_API_KEY=… node tools/poller.mjs --interval 3 --serve
```

There is no linter and no formatter. Match the surrounding style.

## Layout

```
index.html              the dashboard; served as-is by Pages
css/brand.css           YMCA brand tokens — transcribed, not invented
css/dashboard.css       layout + theming; @imports brand.css
js/app.js               wiring: fetch → render, refresh loops, CAMP config
js/data.js              loading the archive (or the embedded snapshot)
js/charts.js            hand-rolled SVG: lineChart, barChart, sparkline, windRose, legend
js/radar.js             RainViewer tiles over a CARTO basemap on a canvas
js/strikes.js           the lightning panel + haversine/bearing maths
js/sun.js               NOAA sunrise/sunset from the station's coordinates
tools/wu.mjs            Weather Underground client + normalise()
tools/lightning.mjs     Xweather / Ecowitt / Ambient clients
tools/store.mjs         the archive on disk: merges, rollups, indexes
tools/archive.mjs       entry point — the every-run observation pull
tools/lightning-archive.mjs   entry point — strikes or counter samples
tools/backfill.mjs      entry point — seed history, one API call per day
tools/poller.mjs        entry point — long-running camp-side archiver (+ --serve)
tools/build-single.mjs  entry point — inline everything into one HTML file
tools/doctor.mjs        entry point — preflight against the live APIs
tests/*.test.mjs        node:test; no install, no runner config
data/                   MACHINE-WRITTEN. See below.
assets/                 the Y logo; read assets/README.md before touching it
```

## Data flow

```
WU API ──normalise()──> flat records ──mergeRecords()──> data/obs/YYYY-MM-DD.json
                                            │
                                    updateDaily() ──> data/daily.json   (rollup per day)
                                    updateIndex() ──> data/index.json   (which days exist)
                                    writeLatest() ──> data/latest.json  (newest + today + meta)

data/lightning/  the same four shapes, from a different provider on a different
                 cadence — kept separate so the observation archive never gains
                 or loses days depending on whether a detector is configured.

browser: js/data.js fetches those files. Ranges ≤ 7 days draw the full-resolution
         observations; longer ranges draw daily.json.
```

`data/` is written by `tools/archive.mjs` / `tools/lightning-archive.mjs`, running
in CI or under the poller. **Never hand-edit files under `data/`**, and never
commit `data/` changes as part of a code change — archive commits are generated
(`Archive weather observations <ISO>Z`) and the Tests workflow deliberately
ignores `data/**`.

## Invariants that break quietly

These are the ones where a wrong change still runs, still renders, and is wrong.

**Wind-rose bin edges are duplicated across the boundary.** `ROSE_EDGES` and
`CALM_MPH` in `tools/store.mjs:103` pre-compute rose bins into the daily
rollups; `WIND_EDGES`, `CALM_MPH` and `WIND_BINS` in `js/app.js:64` compute the
same bins in the browser for short ranges. Change one and the rose silently
means different things either side of the 7-day boundary. Change both.

**Every field the high-resolution view shows must have a daily counterpart.**
Long ranges render entirely from `summarise()` in `tools/store.mjs`. Adding a
metric to the dashboard without adding it to the rollup makes it vanish past
7 days. Extremes carry the *epoch they happened at* (`tempMaxAt`, `gustMaxAt`),
not just the value, so "when" survives the switch.

**Missing sensors are `null`, never `0`.** `num()` and `pick()` in `wu.mjs`
enforce it; the dashboard's `has()` guard turns null into `—`. A station without
UV gets an empty column, not a row of fake zeroes. `tests/normalise.test.mjs`
pins both directions ("a genuine zero survives").

**Days bucket by station-local date, not UTC.** `localDate()` slices
`obsTimeLocal`. Lightning has no local stamp, so `store.mjs` derives the
station's UTC offset from `latest.json` (the WU payload carries both a local and
a UTC time for the same instant). CI runs in UTC; bucketing by the runner's date
would split a storm across two days.

**`precipTotalIn` is a daily accumulator that resets at local midnight.** A
day's rainfall is its high-water mark (`max`), never a sum of samples. Rain
*between* samples is the positive difference; a decrease means the reset, not
negative rain. Same shape for a lightning counter — but strikes are summed from
positive increments rather than the peak, because a counter that has not reset
yet still reads yesterday's total. See `summariseLightning()` and the tests in
`tests/rollups.test.mjs`.

**Merges are idempotent by key.** Observations merge on `epoch`, strikes on the
provider's strike ID. Every run asks for an *overlapping* window on purpose, so
re-seeing data must stay free: a dropped scheduled run costs currency, never
data. Do not "optimise" a fetch down to a single reading.

**`js/` modules must stay inside the mini-bundler's grammar.**
`tools/build-single.mjs` handles exactly two forms — `import { a, b } from
'./rel.js';` and `export function|async function|const|let|class NAME`. It
*throws* on `export default`, `export { … }`, default imports and side-effect
imports (`UNSUPPORTED_RE`), so those fail the build rather than shipping a broken
offline file. One form slips through both regexes: a **named import from a bare
specifier** (`import { x } from 'somelib'`) is neither rejected nor rewritten,
and lands in the bundle as a raw `import` inside an IIFE — which is exactly why
the browser code has no third-party imports. It also regex-matches three exact
strings in `index.html`: the `css/dashboard.css` `<link>`, the
`js/app.js` module `<script>`, and `src="assets/ymca-logo.svg"`. Rewriting any
of those three lines breaks the single-file build — the build errors on the
first two, and silently drops branding on the third.

**`@import url("brand.css")` is resolved at build time**, because a relative
`@import` cannot resolve inside a single file on a USB stick and the failure is
silent and total. Keep stylesheet imports relative and `@import url(...)`-shaped.

**`[hidden]` is `!important` in `css/dashboard.css`.** The UA default loses to
any `display: flex` of ours, which is how the lightning summary once kept
showing a bare "0" next to "not configured". Don't weaken it.

**"Configured" is not "has data".** `lightningConfigured()` in `js/strikes.js`
reads `index.provider`, *not* `days.length` — a working feed on a quiet day must
not report itself as unconfigured. Most days are quiet days.

## Design conventions

**The layout contract.** Everything above the range filter describes *now*
(current reading, today's extremes, a 24-hour sparkline). Everything below it
describes the *selected range*. So the numbers on screen always agree with each
other. Don't put range-dependent values in the top panels or vice versa.

**Never claim to be current when you aren't.** This is the strongest principle
in the codebase, and it shows up everywhere:

- The staleness chip is driven by its own 30-second timer, not the data fetch,
  so the age keeps climbing when the page can't reach GitHub at all. A frozen
  "2 min ago" is the dangerous failure.
- Live is *quiet*; amber past 20 min, red and pulsing past 90 min
  (`STALE_MIN` / `OFFLINE_MIN` in `js/app.js`). A display that shouts while
  everything is fine trains people to ignore it.
- A blocked radar host says so **in words, naming the host** — a blank radar on
  a camp wall reads as clear skies.
- An empty lightning panel says **"All clear"**, because a blank panel is
  ambiguous and "all clear" is not.
- A missing Y logo renders a red dashed marker, not a tidy gap.
- A failed background refresh leaves the last good screen up and logs; it never
  replaces the wall with an error page.

Preserve this when you touch these paths. If a change can produce a confident
blank, make it produce a labelled failure instead.

**Brand compliance is a hard constraint, not a preference.** `css/brand.css`
transcribes the YMCA of the USA Brand Graphics Guide (452562 1/26) with page
citations. Nothing outside that palette may appear anywhere. Charts follow
"one colour family per chart" (p28) — the `--viz-*` variables are **not**
interchangeable categorical slots. Ordered scales (wind-rose speed bins, strike
distance bands) use a single-hue ordinal ramp. The brand bar stays white in both
themes because the full-colour logo may only sit on white (p11). The logo may
not be recreated, retyped or restyled — see `assets/README.md` before going near
it. One knowing departure is documented: `--logo-name-gap: 1` where p13 asks
for 2.

**Secrets.** Read from the environment only, never written to disk, never in a
URL that reaches a log. `safeUrl()` in both `tools/wu.mjs` and
`tools/lightning.mjs` redacts credentials before any error message is built, and
`tests/providers.test.mjs` asserts the key never appears in a thrown error. Any
new provider needs the same treatment. `.env` is gitignored.

**Comments explain *why*, and they are dense.** This codebase documents the trap
rather than the mechanics — "precipTotal is a running accumulator that resets at
local midnight, so the day's rainfall is its high-water mark". Match that: if
you fix something subtle, leave the reason behind. Prose comments, sentence
case, British-ish spelling (`normalise`, `colour` in prose; DOM/CSS APIs keep
their own spelling).

**Chart rendering.** Labels are set via `textContent` — never `innerHTML`. Charts
are `role="img"` with an `ariaLabel`, keyboard-navigable via arrow keys on focus,
and every chart has a data-table twin. Charts re-render on container resize; each
entry point calls `reset()` first to drop the previous render's ResizeObserver.
Sparklines must be drawn only once the container is in the document — a detached
element measures zero width.

## Tests

`node --test "tests/*.test.mjs"` — 65 tests, no install, no config. Coverage is
aimed at the parts that go quietly wrong:

| File | What it pins |
|---|---|
| `normalise.test.mjs` | one record shape out of both endpoint spellings; null vs zero; local-date bucketing |
| `rollups.test.mjs` | extremes with timestamps, the accumulator and counter-reset traps, both roses |
| `providers.test.mjs` | every provider parser against stubbed `fetch`, plus credential redaction |
| `strikes.test.mjs` | haversine/bearing, radius filtering, recompute-don't-trust, `lightningConfigured` |
| `sun.test.mjs` | solstice/equinox values, polar day, longitude shift |

**`providers.test.mjs` is the record of what we currently believe each API
returns.** Nothing here was written against a live payload. When a live run
disagrees with a fixture, **fix the fixture and the parser together** — the
fixture is a claim about reality, not a mock to be bent until green.

`tools/doctor.mjs` is the live counterpart: it calls each configured API and
reports field by field what actually came back, and exits non-zero so it can
gate a deploy. Run it before trusting a change to any provider client.

## CI and scheduling

- **`.github/workflows/tests.yml`** — every push (ignoring `data/**`), PRs, and
  dispatch. Runs the suite, then `node --check` over every `tools/*.mjs` and
  `js/*.js`, because the archiver and dashboard are never imported by the tests
  and a syntax error would otherwise reach the schedule unnoticed.
- **`.github/workflows/archive.yml`** — `*/5` cron plus `workflow_dispatch`
  (with a `backfill_days` input). Needs `contents: write` and the `WU_API_KEY`
  secret; lightning secrets are optional and the step exits quietly without them.

Both pin **Node 22**. GitHub only fires `schedule` from the default branch, so
on a feature branch the workflow exists but never self-triggers.

**GitHub's scheduler is best-effort and drops runs under load** — a `*/15`
schedule once fired exactly once in eight hours here. Nothing in this repository
can fix that; the design absorbs it (each run re-pulls 24 hours), and
`tools/poller.mjs` is the way off it for a screen that must be reliably current.
If the poller is running, the Actions schedule must be **off** — two writers
committing to `data/` collide. When pushing, the poller runs
`git reset --hard origin/<branch>` before each cycle, so its checkout is a
*deployment, not a working copy*; it refuses to run at all if it finds
uncommitted changes outside `data/`.

## Gotchas

- **Node 22, not 20.** `node --test` only learned to expand glob patterns in 22.
  On 20 it reads `"tests/*.test.mjs"` as a literal filename and exits 1 without
  running anything — the job looked red while testing nothing.
- **`file://` won't work** for the dashboard; `fetch()` needs `http://`. Use
  `python3 -m http.server 8000`, or `tools/build-single.mjs` for a real offline
  file (which embeds the archive in `globalThis.__WX_SNAPSHOT` and bypasses
  fetch entirely).
- **RainViewer serves radar tiles only to zoom 7** and returns a "Zoom Level Not
  Supported" placeholder above it, so `js/radar.js` draws the basemap and the
  radar at different zooms and scales the radar up by the power-of-two
  difference.
- **Weather Underground carries no lightning fields at all.** Lightning must come
  from a separate provider; see the source table in the README before proposing
  one. Blitzortung's terms forbid this use.
- **Two hosts must be reachable** for radar: `api.rainviewer.com` and
  `basemaps.cartocdn.com`.
- **Barometric pressure and solar radiation are archived but deliberately not
  displayed.** Putting either card back is a markup change, not a data
  migration — don't "fix" the omission without being asked.
- A few comments still say the archive commits every 15 minutes; the schedule is
  `*/5` (see `archive.yml`). Trust the workflow, not the stale comment.

## Working in this repository

- Development happens on feature branches; `main` is the default branch and what
  Pages serves.
- Commit subjects are **imperative, sentence case, no prefix or tag**, and they
  usually state the *why* rather than the file touched: "Run CI on Node 22 so the
  test job actually runs the tests", "Tell 'no lightning provider' apart from
  'no lightning today'". Bodies are prose paragraphs explaining the reasoning and
  the tradeoffs — match that depth for anything non-trivial.
- Run `node --test "tests/*.test.mjs"` before committing. Run
  `node --check` on any file you touched under `tools/` or `js/` if you didn't
  run it.
- Keep code changes and archive data out of the same commit.
