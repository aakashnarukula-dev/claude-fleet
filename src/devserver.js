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

// key (`sid:product`) -> record. One server per key.
//   { key, proc, port, url, ready, exited, cwd, repo }
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

// Parse a dev-server readiness banner out of a stdout chunk (may be multi-line).
// Recognizes:
//   Next.js:  "✓ Ready in 1.2s" + a "- Local: http://localhost:3000" line
//   Vite:     "➜  Local:   http://localhost:5173/"
// Returns { url, port } for the FIRST line that carries a localhost/127.0.0.1 URL
// AND a ready/Local marker, else null. Extracting the port from the banner is what
// lets us learn the REAL port when the dev server auto-incremented off a busy one.
function parseReadyBanner(chunk) {
  const text = stripAnsi(chunk);
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?\b\S*/i);
    if (!m) continue;
    // require a readiness marker on the same line so we don't fire on an arbitrary
    // URL echoed in unrelated log output.
    if (!/(\bready\b|Local:|started server|running at|listening)/i.test(line)) continue;
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

// ---- lifecycle -------------------------------------------------------------

// startDevServer({ key, repo, cwd, env, timeoutMs, command, pluginPath, extraPathDirs, homeDir })
//   key       — REQUIRED unique id (caller passes "sid:product"). One server per key.
//   repo      — repo path/name (for CLAUDE_FLEET_REPO context; informational here).
//   cwd       — worktree/workspace dir the dev server runs in (REQUIRED).
//   env       — base env to extend (defaults to process.env).
//   command   — override the launch command (default: `npm run dev`). Array or string.
//   timeoutMs — readiness timeout (default 60000).
//   pluginPath— abs path passed as CFLEET_OID_PLUGIN (default: sibling preview-oid-plugin.js).
// Resolves { url, port, proc } once ready; rejects on spawn failure or timeout.
// A second call for a LIVE key returns the existing { url, port, proc }.
async function startDevServer(opts = {}) {
  const { key, repo, cwd } = opts;
  if (!key) throw new Error('startDevServer: key is required');
  if (!cwd) throw new Error('startDevServer: cwd is required');

  const existing = servers.get(key);
  if (existing && existing.proc && !existing.exited) {
    return { url: existing.url, port: existing.port, proc: existing.proc, reused: true };
  }

  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const port = await freePort();
  const baseEnv = opts.env || process.env;

  // Instrumentation seam (Phase 1b). Point at where the tagging plugin WILL live;
  // do NOT require it to exist — a plain HTML/CSS/JS dev server must still launch.
  const pluginPath = opts.pluginPath || path.join(__dirname, 'preview-oid-plugin.js');

  const env = Object.assign({}, baseEnv, {
    PATH: augmentedPath(baseEnv, opts.extraPathDirs, opts.homeDir),
    PORT: String(port),
    BROWSER: 'none',                 // don't let CRA/others pop a system browser
    CFLEET_INSTRUMENT: '1',
    CFLEET_OID_PLUGIN: pluginPath,
    // TODO(P1b): a Vite repo could pick the tagging plugin up via a `--config`
    // overlay injected here (e.g. append `-- --config <overlay>` to the command),
    // rather than the app's own vite.config. React/Next repos read CFLEET_OID_PLUGIN
    // from their dev config. Left as a seam so we don't hard-wire a framework here.
  });

  // Command: default `npm run dev`, forwarding the allocated port. `-- --port <n>`
  // forwards to the underlying dev binary (Vite + Next both accept --port), so we
  // request the free port on BOTH the PORT env and the CLI flag.
  let cmd;
  if (opts.command) {
    cmd = Array.isArray(opts.command) ? opts.command.join(' ') : String(opts.command);
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
    throw new Error('startDevServer: spawn failed: ' + (e && e.message || e));
  }

  const rec = { key, proc, port, url: `http://localhost:${port}`, ready: false, exited: false, cwd, repo };
  servers.set(key, rec);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let probeTimer = null;
    let hardTimer = null;

    const cleanupTimers = () => {
      if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    };

    const succeed = (info) => {
      if (settled) return; settled = true;
      cleanupTimers();
      rec.ready = true;
      rec.url = info.url; rec.port = info.port;
      resolve({ url: rec.url, port: rec.port, proc });
    };

    const fail = (err) => {
      if (settled) return; settled = true;
      cleanupTimers();
      // kill the half-started tree so a failed/timed-out launch leaves nothing behind.
      try { if (rec.proc && !rec.exited) process.kill(-rec.proc.pid, 'SIGKILL'); } catch (_) {
        try { rec.proc.kill('SIGKILL'); } catch (_) {}
      }
      servers.delete(key);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onOut = (buf) => {
      const banner = parseReadyBanner(buf.toString());
      if (banner) succeed(banner);
    };
    proc.stdout && proc.stdout.on('data', onOut);
    proc.stderr && proc.stderr.on('data', onOut);   // Vite/Next print the banner to either stream

    proc.on('error', (e) => fail(new Error('dev server process error: ' + (e && e.message || e))));
    proc.on('exit', (code, signal) => {
      rec.exited = true;
      if (!settled) fail(new Error(`dev server exited before ready (code=${code} signal=${signal})`));
    });

    // TCP probe loop — resolves as soon as the port accepts, independent of banner text.
    const pump = async () => {
      if (settled) return;
      const ok = await probeOnce(port);
      if (settled) return;
      if (ok) { succeed({ url: `http://localhost:${port}`, port }); return; }
      probeTimer = setTimeout(pump, 300);
    };
    probeTimer = setTimeout(pump, 300);

    hardTimer = setTimeout(() => fail(new Error(`dev server readiness timeout after ${timeoutMs}ms`)), timeoutMs);
  });
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

// Stop every tracked server (used on app teardown). Returns count stopped.
function stopAll() {
  let n = 0;
  for (const key of Array.from(servers.keys())) { stopDevServer(key); n++; }
  return n;
}

module.exports = {
  startDevServer, stopDevServer, statusOf, stopAll,
  // exported for unit tests / callers:
  freePort, parseReadyBanner, augmentedPath, _servers: servers,
};
