/*
 * Camp-centred weather radar.
 *
 * RainViewer publishes a free, keyless frame index at
 * api.rainviewer.com/public/weather-maps.json listing the last ~2 hours of
 * radar mosaics as slippy-tile paths. This composites those tiles over a
 * muted CARTO basemap on a canvas, centres the view on camp, rings the
 * 25-mile radius, and animates the frames so the screen shows which way a
 * cell is actually moving — the one thing a still image cannot tell you.
 *
 * No API key, so nothing secret ends up in the page. Both hosts must be
 * reachable from wherever the screen lives; if either is blocked the panel
 * says so in words rather than sitting blank, because a blank radar on a
 * camp wall reads as "clear skies".
 */

const FRAME_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const BASE_TILES = 'https://basemaps.cartocdn.com/light_all';
const ATTRIB = '© OpenStreetMap · © CARTO · radar RainViewer';

const TILE = 256;

/*
 * RainViewer serves radar tiles up to zoom 7 and returns a "Zoom Level Not
 * Supported" placeholder above it. The basemap has no such limit, and framing
 * the 25-mile ring sensibly wants zoom 9-ish, so the two layers are drawn at
 * different zooms: the basemap at whatever frames the ring, the radar at 7,
 * scaled up by the power-of-two difference. Web Mercator tiles nest exactly,
 * so a z7 tile drawn at 4x lands precisely over the four z9 tiles it contains.
 *
 * Little is lost to the upscale: at this latitude z7 is ~900 m per pixel,
 * which is already about the native resolution of the underlying radar mosaic.
 */
const RADAR_MAX_Z = 7;

const MAX_FRAMES = 10;        // ~50 minutes of history at 5-minute steps
const FRAME_MS = 420;         // per-frame dwell
const HOLD_MS = 1600;         // pause on the newest frame
const REFRESH_MS = 5 * 60_000;

const MI_PER_DEG_LAT = 69.0;

// ─────────────────────────── slippy tile maths ───────────────────────────

const lonToX = (lon, z) => ((lon + 180) / 360) * Math.pow(2, z);

function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
}

/** Zoom that puts the radius circle at ~78% of the smaller canvas dimension. */
function pickZoom(lat, radiusMi, wPx, hPx) {
  const spanLon = (2 * radiusMi) / (MI_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const target = Math.min(wPx, hPx) * 0.78;
  const z = Math.log2((target * 360) / (spanLon * TILE));
  return Math.max(6, Math.min(11, Math.round(z)));
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);   // a missing tile is a hole, not a failure
    img.src = url;
  });
}

// ─────────────────────────── the panel ───────────────────────────

export function initRadar({ lat, lon }, radiusMi = 25) {
  const frame = document.getElementById('radar-frame');
  const canvas = document.getElementById('radar-canvas');
  const note = document.getElementById('radar-note');
  const timeEl = document.getElementById('radar-time');
  const legend = document.getElementById('radar-legend');
  const attrib = document.getElementById('radar-attrib');
  if (!frame || !canvas) return;

  const ctx = canvas.getContext('2d');

  // Rain intensity ramp, blue family (brand.css). Ordinal, one hue.
  const ramp = document.getElementById('radar-ramp');
  if (ramp && !ramp.childElementCount) {
    for (const v of ['--bin-1', '--bin-2', '--bin-3', '--bin-4', '--bin-5']) {
      const i = document.createElement('i');
      i.style.background = `var(${v})`;
      ramp.appendChild(i);
    }
  }

  let base = null;            // offscreen basemap + rings, drawn once per layout
  let frames = [];            // [{ time, img }]
  let cursor = 0;
  let timer = null;
  let view = null;            // { z, w, h, dpr, originX, originY }
  let stopped = false;

  const say = (msg) => {
    if (!note) return;
    note.textContent = msg;
    note.hidden = !msg;
  };

  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(240, frame.clientWidth);
    const h = Math.max(180, frame.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const z = pickZoom(lat, radiusMi, w, h);
    // World-pixel coordinate of camp, at this zoom.
    const cx = lonToX(lon, z) * TILE;
    const cy = latToY(lat, z) * TILE;
    view = { z, w, h, dpr, originX: cx - w / 2, originY: cy - h / 2 };
  }

  /** Draw the basemap tiles plus the camp marker and radius ring, once. */
  async function buildBase() {
    const { z, w, h, dpr, originX, originY } = view;
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const o = off.getContext('2d');
    o.scale(dpr, dpr);

    o.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--surface-2').trim() || '#e9e9ea';
    o.fillRect(0, 0, w, h);

    const n = Math.pow(2, z);
    const x0 = Math.floor(originX / TILE);
    const x1 = Math.floor((originX + w) / TILE);
    const y0 = Math.floor(originY / TILE);
    const y1 = Math.floor((originY + h) / TILE);

    const jobs = [];
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        if (y < 0 || y >= n) continue;
        const wrapped = ((x % n) + n) % n;
        jobs.push({ x, y, url: `${BASE_TILES}/${z}/${wrapped}/${y}.png` });
      }
    }
    const imgs = await Promise.all(jobs.map((j) => loadImage(j.url)));
    let drawn = 0;
    jobs.forEach((j, i) => {
      if (!imgs[i]) return;
      drawn += 1;
      o.drawImage(imgs[i], j.x * TILE - originX, j.y * TILE - originY, TILE, TILE);
    });

    drawOverlays(o, w, h);
    base = off;
    return drawn > 0;
  }

  /** Radius ring plus the Y triangle as a location pointer (guide p26). */
  function drawOverlays(o, w, h) {
    const { z } = view;
    const pxPerMi = (TILE * Math.pow(2, z))
      / (360 * MI_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    const r = radiusMi * pxPerMi;
    const cx = w / 2;
    const cy = h / 2;

    const css = getComputedStyle(document.documentElement);
    const blue = css.getPropertyValue('--y-blue-dark').trim() || '#0060af';
    const purple = css.getPropertyValue('--y-purple').trim() || '#92278f';

    o.save();
    o.strokeStyle = blue;
    o.globalAlpha = 0.55;
    o.lineWidth = 2;
    o.setLineDash([7, 6]);
    o.beginPath();
    o.arc(cx, cy, r, 0, Math.PI * 2);
    o.stroke();
    o.restore();

    // Inverted triangle, matching the mark in the logo, pointing at camp.
    const s = 15;
    o.save();
    o.fillStyle = purple;
    o.strokeStyle = '#ffffff';
    o.lineWidth = 2.5;
    o.beginPath();
    o.moveTo(cx - s * 0.62, cy - s * 1.15);
    o.lineTo(cx + s * 0.62, cy - s * 1.15);
    o.lineTo(cx, cy);
    o.closePath();
    o.stroke();
    o.fill();
    o.restore();
  }

  function render() {
    if (!base) return;
    const { w, h, dpr } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    const f = frames[cursor];
    if (f && f.img) {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.globalAlpha = 0.78;
      ctx.drawImage(f.img, 0, 0, w, h);
      ctx.restore();
    }
    if (timeEl && f) {
      const d = new Date(f.time * 1000);
      const mins = Math.round((Date.now() / 1000 - f.time) / 60);
      timeEl.hidden = false;
      timeEl.textContent = mins <= 0
        ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : `${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${mins}m ago`;
    }
  }

  function play() {
    clearTimeout(timer);
    if (stopped || frames.length === 0) return;
    render();
    const last = cursor === frames.length - 1;
    cursor = last ? 0 : cursor + 1;
    timer = setTimeout(play, last ? HOLD_MS : FRAME_MS);
  }

  /**
   * A single radar frame, rendered to one image the size of the canvas.
   * Compositing the tiles here rather than at draw time keeps the animation
   * to one drawImage per frame, which matters on the low-powered stick PCs
   * that usually drive a wall display.
   */
  async function buildFrame(host, path) {
    const { z, w, h, dpr, originX, originY } = view;
    const off = document.createElement('canvas');
    off.width = Math.round(w * dpr);
    off.height = Math.round(h * dpr);
    const o = off.getContext('2d');
    o.scale(dpr, dpr);
    // Radar is upscaled from a coarser zoom, so interpolate rather than
    // showing the tile grid as hard squares.
    o.imageSmoothingEnabled = true;
    o.imageSmoothingQuality = 'high';

    // Drop to the radar's maximum zoom and scale back up by the difference.
    const rz = Math.min(z, RADAR_MAX_Z);
    const scale = Math.pow(2, z - rz);
    const rOriginX = originX / scale;
    const rOriginY = originY / scale;
    const rw = w / scale;
    const rh = h / scale;

    const n = Math.pow(2, rz);
    const x0 = Math.floor(rOriginX / TILE);
    const x1 = Math.floor((rOriginX + rw) / TILE);
    const y0 = Math.floor(rOriginY / TILE);
    const y1 = Math.floor((rOriginY + rh) / TILE);

    const jobs = [];
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        if (y < 0 || y >= n) continue;
        const wrapped = ((x % n) + n) % n;
        // size/z/x/y/colour/options — scheme 4, smoothed, no snow layer.
        jobs.push({ x, y, url: `${host}${path}/${TILE}/${rz}/${wrapped}/${y}/4/1_0.png` });
      }
    }
    const imgs = await Promise.all(jobs.map((j) => loadImage(j.url)));
    jobs.forEach((j, i) => {
      if (!imgs[i]) return;
      o.drawImage(
        imgs[i],
        (j.x * TILE - rOriginX) * scale,
        (j.y * TILE - rOriginY) * scale,
        TILE * scale,
        TILE * scale,
      );
    });
    return off;
  }

  async function load() {
    try {
      layout();

      const ok = await buildBase();
      if (!ok) {
        say('Basemap unreachable — check that basemaps.cartocdn.com is allowed on this network.');
        return;
      }

      const res = await fetch(FRAME_INDEX, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`frame index ${res.status}`);
      const index = await res.json();

      const past = index?.radar?.past || [];
      if (!past.length) {
        say('Radar index returned no frames.');
        render();
        return;
      }

      const wanted = past.slice(-MAX_FRAMES);
      const built = await Promise.all(
        wanted.map((f) => buildFrame(index.host, f.path)),
      );
      frames = wanted.map((f, i) => ({ time: f.time, img: built[i] }));
      cursor = 0;

      say('');
      if (legend) legend.hidden = false;
      if (attrib) { attrib.hidden = false; attrib.textContent = ATTRIB; }
      play();
    } catch (err) {
      // Most likely causes: the network blocks one of the two hosts, or the
      // screen is offline. Either way the panel must not look like clear sky.
      say(`Radar unavailable — ${err.message}. The archived readings on this page are unaffected.`);
      if (legend) legend.hidden = true;
      if (timeEl) timeEl.hidden = true;
    }
  }

  // Re-layout on resize (debounced) and refresh the frame list periodically.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { base = null; frames = []; load(); }, 320);
  });

  setInterval(load, REFRESH_MS);
  load();

  return { stop() { stopped = true; clearTimeout(timer); } };
}
