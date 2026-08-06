#!/usr/bin/env node
//
// Keep the archive current from a machine at camp.
//
//   WU_API_KEY=… node tools/poller.mjs
//   WU_API_KEY=… node tools/poller.mjs --interval 3 --serve
//
// GitHub's scheduled workflows are queued best-effort and dropped under load —
// on this repository a */15 schedule fired once in eight hours. That is fine
// for an archive, which re-pulls a 24-hour window on every run and catches up,
// and useless for a wall display that is supposed to show the weather now.
//
// This is the alternative: an ordinary long-running process on a box that is
// already on, with a real timer. It replaces the schedule rather than
// supplementing it — see "One writer" below.
//
// Options:
//   --interval N   minutes between polls (default 3)
//   --serve        also serve the dashboard over HTTP, so the screen reads
//                  data straight off this machine and never waits for a
//                  Pages rebuild
//   --port N       port for --serve (default 8000)
//   --no-push      archive locally and never push; only useful with --serve
//   --once         run one cycle and exit, for testing

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const DEFAULT_INTERVAL_MIN = 3;
const DEFAULT_PORT = 8000;
// Long enough that a slow WU response is not mistaken for a hang, short enough
// that a wedged process cannot block the next poll indefinitely.
const STEP_TIMEOUT_MS = 90_000;
const PUSH_ATTEMPTS = 3;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith('--') ? next : true;
  }
  return args;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${stamp()}  ${msg}`);
const warn = (msg) => console.warn(`${stamp()}  ${msg}`);

/**
 * Run a command and resolve with its exit code and output.
 *
 * shell:false throughout, and every argument passed separately — this has to
 * work on the Windows box in the camp office as well as anywhere else, and
 * quoting rules differ enough that string commands are not portable.
 */
function run(cmd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, shell: false });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} ${args.join(' ')} timed out after ${STEP_TIMEOUT_MS / 1000}s`));
    }, STEP_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFail) {
        reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${(err || out).trim()}`));
      } else {
        resolve({ code, out: out.trim(), err: err.trim() });
      }
    });
  });
}

const git = (...args) => run('git', args);
const gitSoft = (...args) => run('git', args, { allowFail: true });

/**
 * Anything changed outside data/? If so this checkout is being worked on, and
 * resetting to origin would throw that away. Refuse instead.
 */
async function dirtyOutsideData() {
  const { out } = await git('status', '--porcelain');
  return out.split('\n')
    // Porcelain is "XY path", but run() has already trimmed the output, so the
    // leading space of an unstaged entry is gone on the first line and a fixed
    // slice(3) lands mid-filename. Strip the status field by shape instead.
    .map((line) => line.trim().replace(/^\S{1,2}\s+/, ''))
    .filter(Boolean)
    .filter((path) => !path.startsWith('data/'));
}

/**
 * Take origin as the source of truth before archiving.
 *
 * The archiver re-pulls a full 24-hour window and merges by timestamp, so
 * discarding local data/ and rebuilding costs nothing for anything recent —
 * and it means this process can never diverge from the remote, which is what
 * makes the push path simple enough to trust unattended.
 */
async function syncFromOrigin(branch) {
  const dirty = await dirtyOutsideData();
  if (dirty.length) {
    throw new Error(
      `refusing to reset: uncommitted changes outside data/ — ${dirty.join(', ')}. `
      + 'This checkout is meant to be a deployment, not a working copy.',
    );
  }
  await git('fetch', 'origin', branch);
  await git('reset', '--hard', `origin/${branch}`);
}

async function archive() {
  const wu = await run(process.execPath, [join('tools', 'archive.mjs')], { allowFail: true });
  if (wu.code !== 0) {
    // A failed observation pull is worth shouting about; it is the whole point.
    warn(`archive failed: ${(wu.err || wu.out).split('\n').pop()}`);
  } else if (wu.out) {
    log(wu.out.split('\n').pop());
  }

  // Exits quietly when no lightning provider is set, so it runs unconditionally.
  const bolt = await run(process.execPath, [join('tools', 'lightning-archive.mjs')], { allowFail: true });
  if (bolt.code !== 0) {
    warn(`lightning failed: ${(bolt.err || bolt.out).split('\n').pop()}`);
  } else if (bolt.out && !/no lightning provider/.test(bolt.out)) {
    log(bolt.out.split('\n').pop());
  }
  return wu.code === 0;
}

async function commitAndPush(branch) {
  const { out: status } = await git('status', '--porcelain', 'data');
  if (!status) return 'nothing new';

  await git('add', 'data');
  await git('commit', '-m', `Archive weather observations ${new Date().toISOString().slice(0, 16)}Z`);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    const push = await gitSoft('push', 'origin', `HEAD:${branch}`);
    if (push.code === 0) return 'pushed';

    // Something else committed while we were fetching — almost certainly the
    // Actions workflow, if it has not been switched off. Rebase onto it and
    // try again; the data merges by timestamp either way.
    warn(`push rejected (attempt ${attempt}/${PUSH_ATTEMPTS}), rebasing onto origin`);
    await git('fetch', 'origin', branch);
    const rebase = await gitSoft('rebase', `origin/${branch}`);
    if (rebase.code !== 0) {
      // Conflicting edits to the same day file. The next cycle resets to
      // origin and re-pulls the window, which resolves it without guesswork.
      await gitSoft('rebase', '--abort');
      warn('rebase conflicted; leaving it for the next cycle to rebuild from origin');
      return 'deferred';
    }
  }
  return 'push failed';
}

// ─────────────────────────── optional local server ───────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serve the dashboard straight off this machine.
 *
 * Point the screen here instead of at Pages and the whole GitHub round trip
 * leaves the critical path: no commit, no Pages build, no CDN. The archive
 * still gets pushed for permanence, but the display no longer waits on it.
 */
function serve(port) {
  createServer(async (req, res) => {
    try {
      // Collapse repeated slashes first: a leading "//" parses as a
      // scheme-relative URL and the pathname comes back as something other
      // than what was asked for. Kiosk browsers do send these.
      const url = new URL(req.url.replace(/\/{2,}/g, '/'), 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';

      // normalize() collapses ..; the prefix check then keeps the served tree
      // inside the repo even if something slips through.
      const file = join(ROOT, normalize(path).replace(/^([/\\])+/, ''));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404).end('not found'); return; }

      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size,
        // The archive changes under the screen every few minutes.
        'Cache-Control': 'no-cache',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(port, () => {
    log(`serving the dashboard on http://localhost:${port}/  — point the screen here`);
  });
}

// ─────────────────────────── the loop ───────────────────────────

async function cycle(branch, push) {
  try {
    if (push) await syncFromOrigin(branch);
    const ok = await archive();
    if (!ok) return;
    if (push) log(await commitAndPush(branch));
  } catch (err) {
    // Never exit. A camp screen that stops updating because the network
    // blipped at 2am is worse than one that logs and tries again.
    warn(`cycle failed: ${err.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const minutes = Number(args.interval || DEFAULT_INTERVAL_MIN);
  if (!Number.isFinite(minutes) || minutes < 1) {
    throw new Error('--interval must be at least 1 minute');
  }
  const push = !args['no-push'];

  if (!process.env.WU_API_KEY) {
    throw new Error('WU_API_KEY is not set — the poller has nothing to fetch with.');
  }

  const { out: branch } = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (push && (branch === 'HEAD' || !branch)) {
    throw new Error('detached HEAD — check out the branch you want to archive into');
  }

  if (args.serve) serve(Number(args.port || DEFAULT_PORT));

  log(`polling every ${minutes} min${push ? ` and pushing to ${branch}` : ' (local only)'}`);
  await cycle(branch, push);
  if (args.once) return;

  setInterval(() => { cycle(branch, push); }, minutes * 60_000);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
