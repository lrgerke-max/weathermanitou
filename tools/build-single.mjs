#!/usr/bin/env node
//
// Build the whole dashboard — markup, styles, scripts and the data — into one
// self-contained HTML file that runs with no server and no network. Open it
// from the desktop, put it on a USB stick, mail it to someone.
//
//   node weather/tools/build-single.mjs                # last 7 days at full resolution
//   node weather/tools/build-single.mjs --days 30
//   node weather/tools/build-single.mjs --out ~/station.html
//
// Every day's *summary* is always embedded (daily.json is small), so the long
// ranges work in full. --days controls how much full-resolution observation
// data rides along, which is what actually drives the file size.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENTRY = 'js/app.js';

// ─────────────────────────── a very small bundler ───────────────────────────
//
// The dashboard's modules use exactly two ES syntaxes: named function/const
// exports, and named imports of relative paths. Rather than pull in a bundler
// for that, this rewrites those two forms into a tiny module registry — and
// throws on anything it does not recognise, so an unsupported construct fails
// the build instead of silently producing a broken page.

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)';?\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const UNSUPPORTED_RE = /^export\s+default|^export\s*\{|^import\s+[^{]/m;

async function loadModule(specifier) {
  const source = await readFile(join(ROOT, specifier), 'utf8');

  const unsupported = source.match(UNSUPPORTED_RE);
  if (unsupported) {
    throw new Error(`${specifier}: unsupported module syntax "${unsupported[0].trim()}" — ` +
      'this builder handles named imports and named declaration exports only');
  }

  const deps = [];
  let body = source.replace(IMPORT_RE, (_, names, from) => {
    const target = normalise(specifier, from);
    deps.push(target);
    return `const {${names.trim()}} = __require(${JSON.stringify(target)});`;
  });

  const exports = [];
  body = body.replace(EXPORT_DECL_RE, (_, keyword, name) => {
    exports.push(name);
    return `${keyword} ${name}`;
  });

  return { specifier, body, deps, exports };
}

/** Resolve './charts.js' seen from 'js/app.js' into 'js/charts.js'. */
function normalise(fromSpecifier, relative) {
  const dir = dirname(fromSpecifier);
  return join(dir, relative).split('\\').join('/');
}

async function bundle(entry) {
  const modules = new Map();

  const visit = async (specifier) => {
    if (modules.has(specifier)) return;
    const module = await loadModule(specifier);
    modules.set(specifier, module);
    for (const dep of module.deps) await visit(dep);
  };
  await visit(entry);

  // Dependencies first, so every module is defined before anything requires it.
  const ordered = [];
  const seen = new Set();
  const emit = (specifier) => {
    if (seen.has(specifier)) return;
    seen.add(specifier);
    const module = modules.get(specifier);
    for (const dep of module.deps) emit(dep);
    ordered.push(module);
  };
  emit(entry);

  const defined = ordered.map((module) => (
    `__define(${JSON.stringify(module.specifier)}, function () {\n` +
    `${module.body}\n` +
    `return { ${module.exports.join(', ')} };\n});`
  )).join('\n\n');

  return `(function () {
'use strict';
var __modules = {}, __cache = {};
function __define(name, factory) { __modules[name] = factory; }
function __require(name) {
  if (!(name in __cache)) {
    if (!(name in __modules)) throw new Error('missing module ' + name);
    __cache[name] = __modules[name]();
  }
  return __cache[name];
}

${defined}

__require(${JSON.stringify(entry)});
})();`;
}

// ─────────────────────────── the data snapshot ───────────────────────────

async function readJson(path) {
  try {
    return JSON.parse(await readFile(join(ROOT, 'data', path), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function snapshot(days) {
  const index = await readJson('index.json');
  if (!index?.days?.length) {
    throw new Error('no archived data yet — run weather/tools/archive.mjs first');
  }

  const daily = await readJson('daily.json') || { days: [] };
  const latest = await readJson('latest.json');
  const embedded = index.days.slice(-days);

  const files = {
    'daily.json': daily,
    'latest.json': latest,
    // `days` lists what is actually in this file, so the dashboard never asks
    // for an observation file the snapshot does not carry.
    'index.json': {
      ...index,
      days: embedded,
      snapshot: {
        generatedAt: new Date().toISOString(),
        observationDays: embedded.length,
        archivedDays: index.days.length,
      },
    },
  };

  for (const date of embedded) {
    const day = await readJson(`obs/${date}.json`);
    if (day) files[`obs/${date}.json`] = day;
  }
  return { files, index, embedded };
}

// ─────────────────────────── assembly ───────────────────────────

/** JSON safe to sit inside a <script> block. */
const embed = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = Number(args.days || 7);
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');

  const { files, index, embedded } = await snapshot(days);
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const css = await readFile(join(ROOT, 'css/dashboard.css'), 'utf8');
  const script = await bundle(ENTRY);

  let out = html.replace(
    /<link rel="stylesheet" href="css\/dashboard\.css">/,
    `<style>\n${css}\n</style>`
  );
  if (out === html) throw new Error('could not find the stylesheet link in index.html');

  const before = out;
  out = out.replace(
    /<script type="module" src="js\/app\.js"><\/script>/,
    `<script>\nglobalThis.__WX_SNAPSHOT = ${embed(files)};\n</script>\n<script>\n${script}\n</script>`
  );
  if (out === before) throw new Error('could not find the module script tag in index.html');

  const station = index.station || 'station';
  const date = (embedded[embedded.length - 1] || 'snapshot');
  const target = args.out
    ? resolve(args.out)
    : join(ROOT, 'dist', `${station}-${date}.html`);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out);

  const kb = Math.round(Buffer.byteLength(out) / 1024);
  console.log(`wrote ${target}`);
  console.log(`  ${kb} KB · ${embedded.length} day(s) of observations · ` +
    `${files['daily.json'].days.length} daily summaries`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
