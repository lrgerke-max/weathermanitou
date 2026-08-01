// Hand-rolled SVG charts — no libraries, no build step.
//
// Shared conventions (see the dataviz specs these follow): 2px lines with round
// caps, area washes at 10%, ≥8px markers carrying a 2px surface ring, hairline
// solid gridlines, a crosshair + one tooltip listing every series, and direct
// value labels only at the line ends.

const NS = 'http://www.w3.org/2000/svg';
const PAD = { top: 12, right: 64, bottom: 26, left: 46 };
const HEIGHT = 240;
const MIN_WIDTH = 280;

function el(name, attrs) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  return node;
}

function text(value, attrs, cls) {
  const node = el('text', attrs);
  if (cls) node.setAttribute('class', cls);
  node.textContent = value;          // labels are data — never innerHTML
  return node;
}

/** Round tick values to something a person would choose. */
function niceTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step / 1000; t += step) {
    ticks.push(Math.round(t / step) * step);
  }
  return ticks;
}

function extent(points, keys) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const point of points) {
    for (const key of keys) {
      const value = point[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
  }
  if (lo === Infinity) return null;
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

// ─────────────────────────── tooltip ───────────────────────────

const tooltip = () => document.getElementById('tooltip');

function showTooltip(when, rows, clientX, clientY) {
  const node = tooltip();
  if (!node) return;
  node.replaceChildren();

  const head = document.createElement('div');
  head.className = 'when';
  head.textContent = when;
  node.append(head);

  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'row';
    const key = document.createElement('span');
    key.className = 'key';
    key.style.background = row.color;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = row.value;         // value leads
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.name;         // label follows
    line.append(key, val, name);
    node.append(line);
  }

  node.hidden = false;
  const box = node.getBoundingClientRect();
  const x = Math.min(clientX + 14, window.innerWidth - box.width - 8);
  const y = Math.max(8, Math.min(clientY - box.height / 2, window.innerHeight - box.height - 8));
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${y}px`;
}

function hideTooltip() {
  const node = tooltip();
  if (node) node.hidden = true;
}

// ─────────────────────────── shared frame ───────────────────────────

function frame(width, yDomain, formatTick) {
  const group = el('g', {});
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const scaleY = (v) => PAD.top + plotH - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * plotH;

  for (const tick of niceTicks(yDomain[0], yDomain[1], 5)) {
    const y = scaleY(tick);
    if (y < PAD.top - 1 || y > HEIGHT - PAD.bottom + 1) continue;
    group.append(el('line', {
      class: 'gridline', x1: PAD.left, x2: width - PAD.right, y1: y, y2: y,
    }));
    group.append(text(formatTick(tick), {
      x: PAD.left - 8, y: y + 3.5, 'text-anchor': 'end',
    }, 'tick-label'));
  }

  group.append(el('line', {
    class: 'axis-line',
    x1: PAD.left, x2: width - PAD.right,
    y1: HEIGHT - PAD.bottom, y2: HEIGHT - PAD.bottom,
  }));

  return { group, scaleY };
}

function xTicks(svg, width, points, scaleX, xFormat) {
  const count = Math.max(2, Math.min(6, Math.floor((width - PAD.left - PAD.right) / 90)));
  const step = Math.max(1, Math.floor((points.length - 1) / (count - 1)));
  const seen = new Set();
  for (let i = 0; i < points.length; i += step) {
    const label = xFormat(points[i].x);
    if (seen.has(label)) continue;
    seen.add(label);
    const x = scaleX(points[i].x);
    if (x > width - PAD.right - 12) continue;
    svg.append(text(label, {
      x, y: HEIGHT - PAD.bottom + 15, 'text-anchor': i === 0 ? 'start' : 'middle',
    }, 'tick-label'));
  }
}

/**
 * Drop the previous render's resize observer.
 *
 * Every entry point calls this first, including the ones that bail out to an
 * empty state: an observer left over from an earlier range still holds that
 * range's draw closure, and would repaint the old chart on the next resize.
 */
function reset(container) {
  if (container._wxObserver) {
    container._wxObserver.disconnect();
    container._wxObserver = null;
  }
}

/** Re-render on container resize so text stays at its true pixel size. */
function responsive(container, draw) {
  let queued = false;
  const run = () => {
    queued = false;
    const width = Math.max(MIN_WIDTH, Math.floor(container.clientWidth) || MIN_WIDTH);
    container.replaceChildren(draw(width));
  };
  run();
  const observer = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  });
  observer.observe(container);
  container._wxObserver = observer;
}

function emptyState(message) {
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = message;
  return node;
}

// ─────────────────────────── line chart ───────────────────────────

/**
 * @param {object} spec
 *   points      [{x, ...}] ascending by x
 *   series      [{key, name, color}]
 *   band        optional {lowKey, highKey, color, name}
 *   format      value → tooltip/label string
 *   formatTick  value → axis string
 *   xFormat     x → axis/tooltip string
 */
export function lineChart(container, spec) {
  const { points, series, band } = spec;
  const keys = series.map((s) => s.key).concat(band ? [band.lowKey, band.highKey] : []);
  const domain = points.length ? extent(points, keys) : null;
  reset(container);

  if (!domain) {
    container.replaceChildren(emptyState('No data in this range yet.'));
    return;
  }

  responsive(container, (width) => {
    const svg = el('svg', {
      class: 'chart', width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`,
      tabindex: '0', role: 'img', 'aria-label': spec.ariaLabel || 'chart',
    });

    const xs = points.map((p) => p.x);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const span = xMax - xMin || 1;
    const scaleX = (x) => PAD.left + ((x - xMin) / span) * (width - PAD.left - PAD.right);

    const { group, scaleY } = frame(width, domain, spec.formatTick);
    svg.append(group);
    xTicks(svg, width, points, scaleX, spec.xFormat);

    // Band (daily high–low) sits under the lines as a wash.
    if (band) {
      const top = [];
      const bottom = [];
      for (const point of points) {
        const hi = point[band.highKey];
        const lo = point[band.lowKey];
        if (typeof hi !== 'number' || typeof lo !== 'number') continue;
        top.push(`${scaleX(point.x)},${scaleY(hi)}`);
        bottom.unshift(`${scaleX(point.x)},${scaleY(lo)}`);
      }
      if (top.length > 1) {
        svg.append(el('polygon', {
          points: top.concat(bottom).join(' '), fill: band.color, 'fill-opacity': '0.1',
        }));
      }
    }

    // Lines. A gap in the data breaks the path rather than bridging it.
    for (const s of series) {
      let d = '';
      let pen = false;
      for (const point of points) {
        const value = point[s.key];
        if (typeof value !== 'number' || !Number.isFinite(value)) { pen = false; continue; }
        const cmd = pen ? 'L' : 'M';
        d += `${cmd}${scaleX(point.x).toFixed(1)},${scaleY(value).toFixed(1)}`;
        pen = true;
      }
      if (d) {
        svg.append(el('path', {
          d, fill: 'none', stroke: s.color, 'stroke-width': '2',
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }));
      }
    }

    // Direct value labels at the line ends, with leader lines when they collide.
    const ends = [];
    for (const s of series) {
      for (let i = points.length - 1; i >= 0; i -= 1) {
        const value = points[i][s.key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          ends.push({ series: s, x: scaleX(points[i].x), y: scaleY(value), value });
          break;
        }
      }
    }
    ends.sort((a, b) => a.y - b.y);
    const GAP = 13;
    for (let i = 1; i < ends.length; i += 1) {
      if (ends[i].y - ends[i - 1].y < GAP) ends[i].labelY = ends[i - 1].labelY ?? ends[i - 1].y;
    }
    for (let i = 1; i < ends.length; i += 1) {
      const previous = ends[i - 1].labelY ?? ends[i - 1].y;
      if (ends[i].y - previous < GAP) ends[i].labelY = previous + GAP;
    }
    for (const end of ends) {
      const labelY = end.labelY ?? end.y;
      svg.append(el('circle', {
        cx: end.x, cy: end.y, r: 4, fill: end.series.color,
        stroke: 'var(--surface-1)', 'stroke-width': '2',
      }));
      if (Math.abs(labelY - end.y) > 1) {
        svg.append(el('line', {
          x1: end.x + 6, y1: end.y, x2: end.x + 12, y2: labelY,
          stroke: 'var(--axis)', 'stroke-width': '1',
        }));
      }
      // The card subtitle carries the unit, so the end label stays compact.
      svg.append(text((spec.formatEnd || spec.format)(end.value), {
        x: end.x + 14, y: labelY + 3.5, 'text-anchor': 'start',
      }, 'end-label'));
    }

    // ── hover layer: crosshair snaps to the nearest x, tooltip lists every series
    const hair = el('line', {
      class: 'crosshair', y1: PAD.top, y2: HEIGHT - PAD.bottom, x1: 0, x2: 0, opacity: '0',
    });
    const dots = el('g', { opacity: '0' });
    svg.append(hair, dots);

    const readout = (index, clientX, clientY) => {
      const point = points[index];
      hair.setAttribute('x1', scaleX(point.x));
      hair.setAttribute('x2', scaleX(point.x));
      hair.setAttribute('opacity', '1');
      dots.replaceChildren();
      const rows = [];
      for (const s of series) {
        const value = point[s.key];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        dots.append(el('circle', {
          cx: scaleX(point.x), cy: scaleY(value), r: 4, fill: s.color,
          stroke: 'var(--surface-1)', 'stroke-width': '2',
        }));
        rows.push({ name: s.name, color: s.color, value: spec.format(value) });
      }
      dots.setAttribute('opacity', '1');
      showTooltip(spec.xFormat(point.x, true), rows, clientX, clientY);
    };

    const nearest = (clientX) => {
      const box = svg.getBoundingClientRect();
      const x = clientX - box.left;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < points.length; i += 1) {
        const dist = Math.abs(scaleX(points[i].x) - x);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      return best;
    };

    const clear = () => {
      hair.setAttribute('opacity', '0');
      dots.setAttribute('opacity', '0');
      hideTooltip();
    };

    svg.addEventListener('pointermove', (event) => {
      readout(nearest(event.clientX), event.clientX, event.clientY);
    });
    svg.addEventListener('pointerleave', clear);

    // Keyboard reaches the same readout as the pointer.
    let cursor = points.length - 1;
    svg.addEventListener('focus', () => {
      const box = svg.getBoundingClientRect();
      readout(cursor, box.left + scaleX(points[cursor].x), box.top + HEIGHT / 2);
    });
    svg.addEventListener('blur', clear);
    svg.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      cursor = Math.max(0, Math.min(points.length - 1, cursor + (event.key === 'ArrowRight' ? 1 : -1)));
      const box = svg.getBoundingClientRect();
      readout(cursor, box.left + scaleX(points[cursor].x), box.top + HEIGHT / 2);
    });

    return svg;
  });
}

// ─────────────────────────── bar chart ───────────────────────────

/**
 * @param {object} spec
 *   points  [{x, v, label}] — one bar each, in order
 *   color   fill
 *   format / formatTick / xFormat as above
 */
export function barChart(container, spec) {
  const { points, color } = spec;
  const values = points.map((p) => p.v).filter((v) => Number.isFinite(v));
  reset(container);

  if (!points.length) {
    container.replaceChildren(emptyState('No data in this range yet.'));
    return;
  }

  const peak = values.length ? Math.max(...values) : 0;
  if (peak <= 0) {
    // An axis full of zeroes says less than the sentence does.
    container.replaceChildren(emptyState(spec.emptyMessage || 'Nothing recorded in this range.'));
    return;
  }

  // Bars grow from a zero baseline, always — a non-zero floor misstates them.
  const domain = [0, peak * 1.12];

  responsive(container, (width) => {
    const svg = el('svg', {
      class: 'chart', width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`,
      role: 'img', 'aria-label': spec.ariaLabel || 'chart',
    });

    const { group, scaleY } = frame(width, domain, spec.formatTick);
    svg.append(group);

    const plotW = width - PAD.left - PAD.right;
    const band = plotW / points.length;
    const barW = Math.min(24, Math.max(1, band - 2));   // 2px surface gap between neighbours
    const baseline = HEIGHT - PAD.bottom;

    points.forEach((point, i) => {
      const x = PAD.left + band * i + (band - barW) / 2;
      const value = Number.isFinite(point.v) ? point.v : 0;
      const y = scaleY(value);
      const height = baseline - y;

      if (height > 0.5) {
        const r = Math.min(4, barW / 2, height);
        svg.append(el('path', {
          d: `M${x},${baseline} L${x},${y + r} Q${x},${y} ${x + r},${y} ` +
             `L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} ` +
             `L${x + barW},${baseline} Z`,
          fill: color,
        }));
      }

      // Hit target spans the whole band, never just the painted pixels.
      const hit = el('rect', {
        x: PAD.left + band * i, y: PAD.top, width: band, height: baseline - PAD.top,
        fill: 'transparent',
      });
      const show = (event) => showTooltip(
        spec.xFormat(point.x, true),
        [{ name: spec.name, color, value: spec.format(value) }],
        event.clientX ?? 0,
        event.clientY ?? 0
      );
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', hideTooltip);
      svg.append(hit);
    });

    xTicks(svg, width, points, (x) => {
      const i = points.findIndex((p) => p.x === x);
      return PAD.left + band * (i < 0 ? 0 : i) + band / 2;
    }, spec.xFormat);

    return svg;
  });
}

/** Legend — always present for two or more series, never for one. */
export function legend(container, series, shape = 'line') {
  container.replaceChildren();
  if (series.length < 2) return;
  const box = document.createElement('div');
  box.className = 'legend';
  for (const s of series) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const key = document.createElement('span');
    key.className = shape === 'rect' ? 'legend-key rect' : 'legend-key';
    key.style.background = s.color;
    const name = document.createElement('span');
    name.textContent = s.name;
    item.append(key, name);
    box.append(item);
  }
  container.append(box);
}
