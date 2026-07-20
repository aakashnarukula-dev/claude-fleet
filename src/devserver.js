// devserver — the Live Preview dev-server MANAGER (Visual Editor Phase 1a).
//
// Spawns a product/worktree's `npm run dev` as a child process, allocates a free
// port deterministically, detects readiness two ways (stdout banner + TCP probe),
// and tears the process tree down on demand. Standalone CommonJS — it deliberately
// does NOT require('electron') so it stays unit-testable under plain node.
//
// Node built-ins only (child_process, net, path, os). No npm deps.
//
// Instrumentation seam (Phase 1b): every launch sets CFLEET_INSTRUMENT=1 and
// CFLEET_OID_PLUGIN=<abs path to the build-time tagging plugin>. The plugin file
// itself is Phase 1b's job — we only DEFINE + pass these env vars per the contract.
// A React/Next repo picks the plugin up via its dev config; absence must NOT break
// launching a plain HTML/CSS/JS dev server (we never hard-require the plugin).

const { spawn, execFileSync } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

// key (`sid:product`) -> record. One server per key.
//   { key, proc, port, url, ready, exited, cwd, repo, pending, settled }
// `pending` holds the in-flight readiness Promise while a start is racing to spawn
// (so a concurrent start for the same key reuses it instead of spawning a 2nd).
const servers = new Map();

const DEFAULT_TIMEOUT_MS = 60000;

// ---- port allocation -------------------------------------------------------

// Probe an OPEN port by binding port 0, reading the OS-assigned port, then
// closing. There is an inherent race (the port is free the instant we close it,
// not necessarily when the dev server binds), but Vite/Next auto-increment off a
// busy port — so we ALSO pass the number and detect the REAL port from the banner.
function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      srv.close((err) => (err ? reject(err) : port ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

// ---- readiness detection ---------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

// A line that looks like an ERROR/warning — the readiness markers below can otherwise
// match a stderr diagnostic that happens to quote a localhost URL (e.g. "Error: cannot
// reach http://localhost:3000"), which would false-ready us against a port the child is
// NOT serving. We skip such lines.
const ERROR_LINE_RE = /\b(error|err!|failed|failure|cannot|could not|exception|unhandled|uncaught|deprecat|ECONN|EADDRINUSE|ENOENT|EACCES|throw)\b/i;
// A GENUINE dev-server banner marker (a real "Local:"/"ready in"/"listening on" line),
// deliberately NARROWER than a bare "ready" so it doesn't fire on prose. On stderr we
// require an even stronger marker (`Local:`/`ready in`) since that stream is noisier.
const BANNER_RE = /(\bLocal:|\bready\s+in\b|\bready\s+-|\bstarted server\b|\brunning at\b|\blistening\b|\bserver running\b)/i;
const STRONG_BANNER_RE = /(\bLocal:|\bready\s+in\b)/i;

// Parse a dev-server readiness banner out of a chunk (may be multi-line).
// Recognizes:
//   Next.js:  "✓ Ready in 1.2s" + a "- Local: http://localhost:3000" line
//   Vite:     "➜  Local:   http://localhost:5173/"
// Returns { url, port } for the FIRST non-error line that carries a localhost/127.0.0.1
// URL AND a real banner marker, else null. Extracting the port from the banner is what
// lets us learn the REAL port when the dev server auto-incremented off a busy one.
// `fromStdout` (default true): a stderr chunk must clear the STRONGER marker so a noisy
// diagnostic can't be mistaken for the ready banner (we prefer stdout).
function parseReadyBanner(chunk, fromStdout = true) {
  const text = stripAnsi(chunk);
  const lines = text.split(/\r?\n/);
  const marker = fromStdout ? BANNER_RE : STRONG_BANNER_RE;
  for (const line of lines) {
    if (ERROR_LINE_RE.test(line)) continue;           // ignore lines that look like errors
    if (!marker.test(line)) continue;                 // require a real banner marker (not a bare "ready")
    const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?\b\S*/i);
    if (!m) continue;
    let url = m[0].replace(/[.,)]+$/, '');           // trim trailing punctuation
    let port = m[1] ? Number(m[1]) : null;
    if (port == null) {
      // no explicit port in the URL (e.g. plain http://localhost) — infer 80.
      port = /^https:/i.test(url) ? 443 : 80;
    }
    // normalize 0.0.0.0 -> localhost for a browsable URL
    url = url.replace('0.0.0.0', 'localhost');
    return { url, port };
  }
  return null;
}

// TCP-probe: resolve true once something ACCEPTS on the port, false on refusal/timeout.
function probeOnce(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
  });
}

// ---- env / PATH ------------------------------------------------------------

// Mirror the PATH augmentation spawnPane uses so `npm`/`node` resolve under a GUI
// app's thin PATH. Callers (main.js) may pass extraDirs (e.g. the bundled CLI dir);
// homebrew + ~/.local/bin + system dirs are always included.
function augmentedPath(baseEnv, extraDirs, homeDir) {
  const home = homeDir || os.homedir();
  const dirs = [
    ...(Array.isArray(extraDirs) ? extraDirs : []),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  const cur = (baseEnv && baseEnv.PATH) || '';
  return dirs.join(':') + (cur ? ':' + cur : '');
}

// ---- best-effort oid-plugin injection (Vite) -------------------------------

// single-quote a path for a POSIX shell command line (handles spaces / quotes).
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Source for a generated Vite config OVERLAY: it loads the repo's OWN config via
// Vite's loadConfigFromFile and appends the data-cfleet-oid tagging babel plugin,
// so the precise React oid path can resolve oid -> source WITHOUT hand-editing the
// repo. Any failure inside falls back to the repo's base config unchanged, so the
// dev server still starts. baseConfigAbs/pluginAbs are absolute paths.
function viteOverlaySource(baseConfigAbs, pluginAbs) {
  const B = JSON.stringify(baseConfigAbs);
  const P = JSON.stringify(pluginAbs);
  return `// AUTO-GENERATED by Claude Fleet Live Preview (dev-only). Loads the repo's own\n`
    + `// Vite config and appends the data-cfleet-oid tagging babel plugin so the React\n`
    + `// visual-editor path can resolve oid -> source. Safe to delete; disable with\n`
    + `// CFLEET_PREVIEW_NO_INJECT=1.\n`
    + `import { loadConfigFromFile, mergeConfig } from 'vite';\n`
    + `import react from '@vitejs/plugin-react';\n`
    + `export default async (env) => {\n`
    + `  let base = {};\n`
    + `  try { const r = await loadConfigFromFile(env, ${B}); if (r && r.config) base = r.config; } catch (_) {}\n`
    + `  try { return mergeConfig(base, { plugins: [react({ babel: { plugins: [${P}] } })] }); }\n`
    + `  catch (_) { return base; }\n`
    + `};\n`;
}

// Best-effort: if `cwd` is a Vite repo (a vite.config.* present + `vite` and
// `@vitejs/plugin-react` resolvable from it) AND the oid plugin file exists, write a
// --config overlay (see viteOverlaySource) and return its path; the caller appends
// `--config <overlay>`. Returns null for anything else — NEVER throws. Graceful
// degrade: with no overlay the repo can still opt in manually (src/preview/README.md)
// and the preview + capture fall back to locate.js Tier-2 selector/role. The overlay
// is written UNDER the repo's node_modules/.cache so its bare imports resolve against
// the repo's deps and it stays out of the worktree's git status. Kill switch:
// CFLEET_PREVIEW_NO_INJECT=1.
function maybeViteConfigOverlay(cwd, pluginPath) {
  try {
    if (process.env.CFLEET_PREVIEW_NO_INJECT) return null;
    if (!pluginPath || !fs.existsSync(pluginPath)) return null;   // no plugin on disk => nothing to inject (never ENOENT the launch)
    const CONFIGS = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts', 'vite.config.cjs', 'vite.config.cts'];
    const base = CONFIGS.map((f) => path.join(cwd, f)).find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
    if (!base) return null;                                       // not a Vite repo => rely on env + manual opt-in
    // vite + @vitejs/plugin-react must be installed in the repo or the overlay can't load.
    const req = require('module').createRequire(path.join(cwd, 'noop.js'));
    try { req.resolve('vite'); req.resolve('@vitejs/plugin-react'); } catch (_) { return null; }
    const outDir = path.join(cwd, 'node_modules', '.cache', 'cfleet');
    fs.mkdirSync(outDir, { recursive: true });
    const overlay = path.join(outDir, 'vite.preview.config.mjs');
    fs.writeFileSync(overlay, viteOverlaySource(base, pluginPath));
    return overlay;
  } catch (_) { return null; }
}

// ---- lifecycle -------------------------------------------------------------

// startDevServer({ key, repo, cwd, env, timeoutMs, command, pluginPath, extraPathDirs, homeDir })
//   key       — REQUIRED unique id (caller passes "sid:product"). One server per key.
//   repo      — repo path/name (for CLAUDE_FLEET_REPO context; informational here).
//   cwd       — worktree/workspace dir the dev server runs in (REQUIRED).
//   env       — base env to extend (defaults to process.env).
//   command   — override the launch command (default: `npm run dev`). Array or string.
//   timeoutMs — readiness timeout (default 60000).
//   pluginPath— abs path passed as CFLEET_OID_PLUGIN (default: src/preview/oid-babel-plugin.js).
// Resolves { url, port, proc } once ready; rejects on spawn failure or timeout.
// A second call for a LIVE key returns the existing { url, port, proc }; a call that
// races an in-flight start for the same key AWAITS that start (no double-spawn).
function startDevServer(opts = {}) {
  const { key, repo, cwd } = opts;
  if (!key) return Promise.reject(new Error('startDevServer: key is required'));
  if (!cwd) return Promise.reject(new Error('startDevServer: cwd is required'));

  // Reuse a live server / AWAIT an in-flight start / RESERVE the key — all SYNCHRONOUSLY
  // (no await before servers.set) so two concurrent starts for the same key can't both
  // spawn a dev server (the 2nd would overwrite the 1st in the Map => an untracked,
  // unkillable child). A pending record parks the readiness Promise for racers to reuse.
  const existing = servers.get(key);
  if (existing) {
    if (existing.pending) return existing.pending;
    if (existing.proc && !existing.exited) {
      return Promise.resolve({ url: existing.url, port: existing.port, proc: existing.proc, reused: true });
    }
  }

  let resolveReady, rejectReady;
  const pending = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  const rec = { key, pending, proc: null, port: null, url: null, ready: false, exited: false, settled: false, cwd, repo };
  servers.set(key, rec);

  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const baseEnv = opts.env || process.env;

  // Instrumentation seam (Phase 1b): the REAL tagging plugin. Its ABSENCE must NOT break
  // launching (a plain HTML/CSS/JS dev server has no React path) — maybeViteConfigOverlay
  // only injects when the file exists; React/Next repos read CFLEET_OID_PLUGIN from their
  // own dev config (best-effort, opt-in). See src/preview/README.md.
  const pluginPath = opts.pluginPath || path.join(__dirname, 'preview', 'oid-babel-plugin.js');

  let probeTimer = null, hardTimer = null, onStdout = null, onStderr = null, bannerInfo = null;

  const cleanup = () => {
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    // stop parsing stdout/stderr once readiness settles — the banner scan runs forever otherwise.
    try { if (rec.proc && rec.proc.stdout && onStdout) rec.proc.stdout.removeListener('data', onStdout); } catch (_) {}
    try { if (rec.proc && rec.proc.stderr && onStderr) rec.proc.stderr.removeListener('data', onStderr); } catch (_) {}
  };

  const succeed = (info) => {
    if (rec.settled) return; rec.settled = true;
    cleanup();
    rec.ready = true; rec.url = info.url; rec.port = info.port; rec.pending = null;
    resolveReady({ url: rec.url, port: rec.port, proc: rec.proc });
  };

  const fail = (err) => {
    if (rec.settled) return; rec.settled = true;
    cleanup();
    // kill the half-started tree so a failed/timed-out launch leaves nothing behind.
    try { if (rec.proc && rec.proc.pid && !rec.exited) process.kill(-rec.proc.pid, 'SIGKILL'); } catch (_) {
      try { rec.proc && rec.proc.kill('SIGKILL'); } catch (_) {}
    }
    rec.exited = true; rec.pending = null;
    if (servers.get(key) === rec) servers.delete(key);
    rejectReady(err instanceof Error ? err : new Error(String(err)));
  };

  // Confirm the BANNER port (the child's REAL port, possibly auto-incremented off a busy
  // pre-allocated one) actually accepts, THEN resolve ready — never resolve against a port
  // the child didn't print. Retries on the 300ms cadence until the hard timeout fires.
  const confirmBanner = async () => {
    for (;;) {
      if (rec.settled || !bannerInfo) return;
      const ok = await probeOnce(bannerInfo.port);
      if (rec.settled || !bannerInfo) return;
      if (ok) { succeed(bannerInfo); return; }
      await new Promise((r) => { probeTimer = setTimeout(r, 300); });
    }
  };

  (async () => {
    let port;
    try { port = await freePort(); }
    catch (e) { fail(new Error('startDevServer: freePort failed: ' + ((e && e.message) || e))); return; }
    rec.port = port; rec.url = `http://localhost:${port}`;

    // Best-effort React oid injection: a Vite repo gets a generated --config overlay that
    // appends the tagging plugin; anything else degrades gracefully (null overlay).
    const overlay = opts.command ? null : maybeViteConfigOverlay(cwd, pluginPath);

    const env = Object.assign({}, baseEnv, {
      PATH: augmentedPath(baseEnv, opts.extraPathDirs, opts.homeDir),
      PORT: String(port),
      BROWSER: 'none',                 // don't let CRA/others pop a system browser
      CFLEET_INSTRUMENT: '1',
      CFLEET_OID_PLUGIN: pluginPath,   // React/Next repos read this from their dev config (manual opt-in)
    });

    // Command: default `npm run dev`, forwarding the allocated port. `-- --port <n>`
    // forwards to the underlying dev binary (Vite + Next both accept --port), so we
    // request the free port on BOTH the PORT env and the CLI flag. A Vite overlay (when
    // present) is forwarded as `--config` alongside.
    let cmd;
    if (opts.command) {
      cmd = Array.isArray(opts.command) ? opts.command.join(' ') : String(opts.command);
    } else if (overlay) {
      cmd = `npm run dev -- --config ${shq(overlay)} --port ${port}`;
    } else {
      cmd = `npm run dev -- --port ${port}`;
    }

    const shell = (baseEnv && baseEnv.SHELL) || process.env.SHELL || '/bin/zsh';
    // Login shell (`-l`) so the user's PATH/nvm etc. load, matching spawnPane. detached
    // so the child leads its own process group — stopDevServer kills the whole group.
    let proc;
    try {
      proc = spawn(shell, ['-l', '-c', `exec ${cmd}`], {
        cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      fail(new Error('startDevServer: spawn failed: ' + ((e && e.message) || e)));
      return;
    }
    rec.proc = proc;

    onStdout = (buf) => {
      if (rec.settled || bannerInfo) return;
      const b = parseReadyBanner(buf.toString(), true);
      if (b) { bannerInfo = b; confirmBanner(); }
    };
    onStderr = (buf) => {
      if (rec.settled || bannerInfo) return;
      const b = parseReadyBanner(buf.toString(), false);   // stricter marker on the noisier stream
      if (b) { bannerInfo = b; confirmBanner(); }
    };
    proc.stdout && proc.stdout.on('data', onStdout);
    proc.stderr && proc.stderr.on('data', onStderr);

    proc.on('error', (e) => fail(new Error('dev server process error: ' + ((e && e.message) || e))));
    proc.on('exit', (code, signal) => {
      rec.exited = true;
      if (!rec.settled) fail(new Error(`dev server exited before ready (code=${code} signal=${signal})`));
    });

    hardTimer = setTimeout(() => fail(new Error(`dev server readiness timeout after ${timeoutMs}ms`)), timeoutMs);
  })();

  return pending;
}

// stopDevServer(key) — kill the process tree for a key. Idempotent. Kills the child's
// process GROUP (child was spawned detached → its own group leader), escalating
// SIGTERM → SIGKILL, then sweeps any lingering listener via `lsof -ti:PORT`.
function stopDevServer(key) {
  const rec = servers.get(key);
  if (!rec) return { ok: true, stopped: false };
  servers.delete(key);                 // remove first so statusOf immediately reads not-running
  const { proc, port } = rec;
  rec.exited = true;

  const killGroup = (sig) => {
    if (!proc || !proc.pid) return;
    try { process.kill(-proc.pid, sig); } catch (_) {
      try { proc.kill(sig); } catch (_) {}
    }
  };

  killGroup('SIGTERM');
  // escalate to SIGKILL shortly after, then lsof-sweep the port as a backstop.
  const t = setTimeout(() => {
    killGroup('SIGKILL');
    lsofKillPort(port);
  }, 2000);
  if (t && t.unref) t.unref();

  return { ok: true, stopped: true };
}

// stopDevServerSync(key) — SYNCHRONOUS force teardown for app quit. Unlike stopDevServer
// (which defers SIGKILL in an unref'd timer), this SIGKILLs the whole process GROUP
// IMMEDIATELY + sweeps the port NOW, because on `will-quit` the process exits before any
// deferred timer could fire (so a plain SIGTERM would orphan the detached `npm run dev`
// children). Idempotent; never throws.
function stopDevServerSync(key) {
  const rec = servers.get(key);
  if (!rec) return { ok: true, stopped: false };
  servers.delete(key);
  rec.settled = true; rec.exited = true; rec.pending = null;
  const { proc, port } = rec;
  if (proc && proc.pid) {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
  }
  lsofKillPort(port);
  return { ok: true, stopped: true };
}

// Best-effort: kill whatever still holds the port (covers a detached grandchild that
// outlived its parent group). Never throws.
function lsofKillPort(port) {
  if (!port) return;
  try {
    const out = execFileSync('lsof', ['-ti', ':' + port], { encoding: 'utf8', timeout: 5000 });
    for (const pid of out.split(/\s+/).map((s) => s.trim()).filter(Boolean)) {
      const n = Number(pid);
      if (Number.isInteger(n) && n > 1) { try { process.kill(n, 'SIGKILL'); } catch (_) {} }
    }
  } catch (_) { /* lsof missing / nothing listening — fine */ }
}

// statusOf(key) -> { running, url, port, ready }
function statusOf(key) {
  const rec = servers.get(key);
  if (!rec) return { running: false, url: null, port: null, ready: false };
  const running = !!(rec.proc && !rec.exited);
  return { running, url: rec.url || null, port: rec.port || null, ready: !!rec.ready };
}

// Stop every tracked server (used on a session close / soft teardown). Returns count stopped.
function stopAll() {
  let n = 0;
  for (const key of Array.from(servers.keys())) { stopDevServer(key); n++; }
  return n;
}

// SYNCHRONOUS stop-all for app QUIT — group-SIGKILLs every tracked server NOW so no
// detached `npm run dev` child survives the process exit. Returns count stopped.
function stopAllSync() {
  let n = 0;
  for (const key of Array.from(servers.keys())) { try { stopDevServerSync(key); n++; } catch (_) {} }
  return n;
}

module.exports = {
  startDevServer, stopDevServer, stopDevServerSync, statusOf, stopAll, stopAllSync,
  // exported for unit tests / callers:
  freePort, parseReadyBanner, augmentedPath, maybeViteConfigOverlay, _servers: servers,
};
