const { app, BrowserWindow, ipcMain, clipboard, Menu, dialog, Notification, powerSaveBlocker, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const os = require('os');
const fsmod = require('fs');
const { execFile, execFileSync } = require('child_process');
const https = require('https');

// Keep the app LIVE in the background: macOS otherwise throttles the renderer (pauses requestAnimationFrame,
// clamps timers) when the window isn't focused — which stalls pane/PTY spawning until you return. These switches
// must be set before app is ready.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let pty = null;
try { pty = require('node-pty'); } catch (e) { /* surfaced on launch */ }

// The fleet engine ships inside the repo at bin/claude-fleet. When packaged it lives under app.asar; since an archived
// file can't be executed, electron-builder unpacks bin/** (see package.json asarUnpack) — rewrite the path accordingly.
// Falls back to a `claude-fleet` on PATH if the bundled copy is somehow missing.
const FLEET_CLI = (() => {
  let p = path.join(__dirname, '..', 'bin', 'claude-fleet');
  if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) p = p.replace('app.asar', 'app.asar.unpacked');
  try { if (fsmod.existsSync(p)) return p; } catch (_) {}
  return 'claude-fleet';
})();

// session persistence — survive an accidental close; restore tabs + resume each Claude conversation on relaunch
function stateFile() { return path.join(app.getPath('userData'), 'claude-fleet-sessions.json'); }
function saveState() {
  try {
    const data = Object.entries(sessions)
      .filter(([, s]) => !s.newProject)   // don't persist throwaway scratch sessions — their dir is disposable/torn down
      .map(([sid, s]) => ({
        sid: +sid, autonomous: !!s.autonomous, repo: s.repo, title: s.title, color: s.color, mode: s.mode, bypass: !!s.bypass,
        panes: (s.panes || []).map((p, i) => (p ? { id: i, role: p.role, heading: p.heading, slug: p.slug, dir: p.dir } : null)).filter(Boolean),
      })).filter((x) => x.panes.length);
    fsmod.writeFileSync(stateFile(), JSON.stringify(data));
  } catch (_) {}
}
function loadState() { try { const d = JSON.parse(fsmod.readFileSync(stateFile(), 'utf8')); return Array.isArray(d) ? d : null; } catch (_) { return null; } }
function clearState() { try { fsmod.unlinkSync(stateFile()); } catch (_) {} }
// Reap finished/orphaned fleet folders left behind by a prior quit/crash (no --next ALL DONE moment). Delegates to the
// engine's guarded sweep (--gc-all, G0-G4): it only removes sessions that are non-live, fully-merged into main, and
// clean — never unmerged work or a running session. `excludeDirs` = absolute fleet dirs to protect (the sessions we're
// about to restore), passed through to the engine so the startup sweep can't race-delete a folder being reopened.
function gcAll(excludeDirs) {
  try {
    const env = Object.assign({}, process.env, { CLAUDE_FLEET_REPO: DEFAULT_REPO });
    if (excludeDirs && excludeDirs.length) env.CLAUDE_FLEET_GC_EXCLUDE = excludeDirs.join(':');
    execFile(FLEET_CLI, ['--gc-all'], { env }, () => {});
  } catch (_) {}
}

// turn a plain folder into a git repo so the fleet can cut worktrees from it (one initial commit on `main`).
// opts.empty -> a throwaway SCRATCH repo: make ONE empty commit and skip seeding a .gitignore / adding files.
function initGitRepo(dir, opts) {
  const empty = !!(opts && opts.empty);
  fsmod.mkdirSync(dir, { recursive: true });
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  run(['init']);
  try { run(['symbolic-ref', 'HEAD', 'refs/heads/main']); } catch (_) {}   // first commit lands on main
  if (empty) {
    run(['-c', 'user.email=fleet@local', '-c', 'user.name=Claude Fleet', 'commit', '--allow-empty', '-m', 'scratch']);
    return;
  }
  const gi = path.join(dir, '.gitignore');
  if (!fsmod.existsSync(gi)) fsmod.writeFileSync(gi, ['node_modules/', 'dist/', 'build/', '.gradle/', '.next/', 'out/', '*.log', '.DS_Store', ''].join('\n'));
  run(['add', '-A']);
  run(['-c', 'user.email=fleet@local', '-c', 'user.name=Claude Fleet', 'commit', '-m', 'Initial commit (claude-fleet)']);
}

// scoped autonomy: auto-approve local dev verbs; push/curl/rm/sudo/unknown still prompt
const ALLOW = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'Bash(claude-fleet:*)',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git merge:*)', 'Bash(git status:*)', 'Bash(git log:*)',
  'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git fetch:*)',
  'Bash(git pull:*)', 'Bash(git restore:*)', 'Bash(git stash:*)', 'Bash(git branch:*)', 'Bash(git tag:*)',
  'Bash(git rev-parse:*)', 'Bash(git rev-list:*)', 'Bash(git for-each-ref:*)', 'Bash(git ls-files:*)',
  'Bash(git blame:*)', 'Bash(git reset:*)', 'Bash(git worktree:*)', 'Bash(git config:*)', 'Bash(git remote:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(find:*)',
  'Bash(wc:*)', 'Bash(echo:*)', 'Bash(pwd)', 'Bash(tree:*)', 'Bash(stat:*)', 'Bash(file:*)', 'Bash(du:*)',
  'Bash(df:*)', 'Bash(which:*)', 'Bash(basename:*)', 'Bash(dirname:*)', 'Bash(realpath:*)', 'Bash(readlink:*)',
  'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(cut:*)', 'Bash(tr:*)', 'Bash(diff:*)', 'Bash(jq:*)', 'Bash(date)',
  'Bash(env)', 'Bash(printenv:*)', 'Bash(test:*)', 'Bash(sleep:*)',
  'Bash(mkdir:*)', 'Bash(touch:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(ln:*)', 'Bash(chmod:*)', 'Bash(sed:*)', 'Bash(awk:*)',
  'Bash(node:*)', 'Bash(npm run:*)', 'Bash(npm install:*)', 'Bash(npm ci:*)', 'Bash(npm test:*)', 'Bash(npm exec:*)',
  'Bash(npm ls:*)', 'Bash(npx:*)', 'Bash(yarn:*)', 'Bash(pnpm:*)', 'Bash(python:*)', 'Bash(python3:*)',
  'Bash(pip install:*)', 'Bash(make:*)', 'Bash(tsc:*)', 'Bash(eslint:*)', 'Bash(prettier:*)', 'Bash(vite:*)',
  'Bash(bun:*)', 'Bash(deno:*)',
  // native / mobile build toolchains (Tauri+Rust, Android/Gradle, iOS, Flutter…) — safe build verbs; cuts worker prompts
  'Bash(cargo:*)', 'Bash(rustc:*)', 'Bash(rustup:*)', 'Bash(tauri:*)', 'Bash(cargo-tauri:*)', 'Bash(go:*)',
  'Bash(gradle:*)', 'Bash(gradlew:*)', 'Bash(./gradlew:*)', 'Bash(swift:*)', 'Bash(xcodebuild:*)', 'Bash(pod:*)',
  'Bash(flutter:*)', 'Bash(dart:*)', 'Bash(dotnet:*)', 'Bash(mvn:*)', 'Bash(cmake:*)', 'Bash(ninja:*)', 'Bash(npm:*)',
];

let configWin = null;
// MULTI-WINDOW: a registry of grid windows + a sid->window routing table replaces the old single `gridWin`.
// PTYs stay keyed by sid:idx and are window-agnostic — moving a session (tear-off / re-dock) just re-points which
// window receives its events; the PTY is untouched and output continues live.
const wins = new Map();         // winId -> { win, ready, queue:[] }  (queue holds sends made before the renderer loaded)
const sidWin = new Map();       // sid (Number) -> winId currently HOSTING that session
const activeSidByWin = new Map(); // winId -> sid (Number) currently VISIBLE in that window (the focused tab); null/absent = none
let lastFocusedGridId = null;   // most-recently-focused grid window (target for new sessions / ⌘N)
let nextSid = 1;
const sessions = {};   // sid -> { repo, title, color, autonomous, panes:[], planReady, pending:{}, slugIdx:{}, statusDir, watcher }
const ptys = {};       // `${sid}:${idx}` -> pty
// Rolling output buffer per live PTY (`${sid}:${idx}` -> { chunks:[], bytes }). Lets a session migrated to another
// window (tab tear-off / re-dock) REPLAY its scrollback + current screen into the fresh xterm instead of showing the
// "Starting Claude…" placeholder. Capped per pane; oldest chunks drop when over PTY_BUF_MAX.
const ptyBuf = {};
const PTY_BUF_MAX = 1 << 21;   // ~2 MiB of raw stream per pane (plenty for a full screen + deep scrollback)

// --- window registry + per-sid routing helpers -------------------------------------------------
function gridWindows() { return [...wins.values()].map((r) => r.win).filter((w) => w && !w.isDestroyed()); }
function winById(id) { const r = (id != null) && wins.get(id); return r && r.win && !r.win.isDestroyed() ? r.win : null; }
function winForSid(sid) { return winById(sidWin.get(Number(sid))); }
// (notifications now fire regardless of which tab is visible — no visibility-based suppression)
function sessionsInWindow(win) { return win ? Object.keys(sessions).filter((sid) => sidWin.get(Number(sid)) === win.id).map(Number) : []; }
function anyGridWin() { return gridWindows()[0] || null; }
function focusedGridWin() { const f = BrowserWindow.getFocusedWindow(); return f && wins.has(f.id) ? f : null; }
// which window should a NEW session land in: the focused grid window, else the last-focused, else a fresh one
function targetGridWin() { return focusedGridWin() || winById(lastFocusedGridId) || anyGridWin() || createGridWindow(); }
// send to a specific window; if its renderer hasn't loaded yet, QUEUE and flush on did-finish-load (no events lost)
function sendToWin(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  const rec = wins.get(win.id); if (!rec) return;
  const fn = () => { if (!win.isDestroyed()) win.webContents.send(channel, payload); };
  if (rec.ready) fn(); else rec.queue.push(fn);
}
function sendToSid(sid, channel, payload) { const w = winForSid(sid); if (w) sendToWin(w, channel, payload); }
// bring the window hosting a sid to the front and focus a pane in it (notifications / tray jumps)
function focusSidPane(sid, id) {
  const w = winForSid(sid); if (!w) return;
  if (w.isMinimized()) w.restore(); w.show(); w.focus();
  sendToWin(w, 'focus-pane', { sid: Number(sid), id });
}

// ── system-wide permission OVERLAY ───────────────────────────────────────────────────────────────────────────
// An always-on-top, all-Spaces panel that mirrors EVERY pending permission prompt across ALL sessions/windows, so
// the user can SEE and ANSWER prompts while another macOS app is frontmost — the in-app grid queue is per-window and
// trapped inside the app. `permQueueAll` is the SINGLE source of truth for the global pending list; it's fed from the
// same perm-prompt stream as the in-app queue (see setPaneState/clearPaneState) and clicking a button answers via the
// existing answerPane() path. The overlay is a SECOND consumer — it never replaces the in-app queue.
const permQueueAll = new Map();   // "sid:id" -> { sid, id, name, title, options:{yes,always,no} }
let overlayWin = null;

function positionOverlay(win) {
  try {
    const { screen } = require('electron');
    const pt = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(pt).workArea;   // monitor the cursor is on
    const b = win.getBounds();
    win.setBounds({ x: wa.x + wa.width - b.width - 16, y: wa.y + 16, width: b.width, height: b.height });
  } catch (_) {}
}

function ensureOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  overlayWin = new BrowserWindow({
    width: 340, height: 460, show: false, frame: false, transparent: true, resizable: false, movable: true,
    skipTaskbar: true, hasShadow: false, fullscreenable: false, minimizable: false, maximizable: false, title: 'Permissions',
    acceptFirstMouse: true,   // a Yes/No click while ANOTHER app is frontmost hits the button directly (not eaten to activate)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  // float above fullscreen apps + every Space, WITHOUT stealing focus from the user's current app
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  try { overlayWin.setWindowButtonVisibility(false); } catch (_) {}
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
  overlayWin.webContents.on('did-finish-load', () => pushOverlay());   // first paint -> push whatever's pending
  positionOverlay(overlayWin);
  return overlayWin;
}

// push the full pending list to the overlay; reveal it (without activating the app) when non-empty, hide when empty
function pushOverlay() {
  const list = Array.from(permQueueAll.values());
  if (list.length) {
    const w = ensureOverlay();
    if (w.webContents.isLoading()) return;   // did-finish-load will push once the renderer is ready
    try { w.webContents.send('perm-queue', list); } catch (_) {}
    positionOverlay(w);
    if (!w.isVisible()) w.showInactive();     // reveal WITHOUT focusing — user keeps their current app frontmost
  } else if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.webContents.send('perm-queue', list); } catch (_) {}
    if (overlayWin.isVisible()) overlayWin.hide();
  }
}

// upsert/remove a prompt in the global queue (mirrors the in-app perm-prompt payload shape) and refresh the overlay
function permUpsert(d) {
  if (!d) return;
  const key = d.sid + ':' + d.id;
  if (d.remove) permQueueAll.delete(key);
  else {
    const isNew = !permQueueAll.has(key);
    permQueueAll.set(key, { sid: d.sid, id: d.id, name: d.name, title: d.title, options: d.options || {} });
    if (isNew) playPermSound();
  }
  pushOverlay();
}

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function gridDims(n) { const cols = Math.ceil(Math.sqrt(n)); return { cols, rows: Math.ceil(n / cols) }; }
const DEFAULT_REPO = os.homedir();   // fallback only (headless tests); the config window always passes a real repo
function repoFor(repo) { return repo ? String(repo).replace(/\/+$/, '') : DEFAULT_REPO; }
function sessionEnv(sid, repo) { return Object.assign({}, process.env, { CLAUDE_FLEET_SESSION: String(sid), CLAUDE_FLEET_REPO: repo }); }

// Per-account chip color, derived deterministically from the account name — no hardcoded account list.
const ACCT_COLORS = ['#ef6c33', '#a855f7', '#3b82f6', '#10b981', '#eab308', '#ec4899', '#06b6d4', '#f97316'];
function accountColor(account) {
  const s = String(account || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ACCT_COLORS[h % ACCT_COLORS.length];
}
// GUI apps inherit a thin PATH — extend it so `gh`/`git` resolve (Homebrew etc.)
const BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
function cmdEnv() { return Object.assign({}, process.env, { PATH: BIN_PATHS.join(':') + (process.env.PATH ? ':' + process.env.PATH : '') }); }
// Resolve a specific gh account's token WITHOUT switching the user's globally-active gh account (gh auth token --user),
// so repo listing/cloning for any connected account is non-disruptive. Returns null if the account/token isn't found.
function ghTokenFor(account) {
  return new Promise((resolve) => {
    if (!account) return resolve(null);
    execFile('gh', ['auth', 'token', '--user', String(account)], { env: cmdEnv(), timeout: 15000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}
function ghEnv(token) { return token ? Object.assign(cmdEnv(), { GH_TOKEN: token }) : cmdEnv(); }
// clone <owner>/<repo> to ~/Developer/<repo> if it isn't there yet, then fetch to refresh. Uses the selected account's
// token (if any) so private repos on a non-active account clone correctly. Prefers gh (handles auth), falls back to git.
async function ensureRepoClone(nameWithOwner, defaultBranch, account) {
  const token = await ghTokenFor(account);
  const env = ghEnv(token);
  const name = String(nameWithOwner).split('/').pop();
  const dest = path.join(os.homedir(), 'Developer', name);
  return new Promise((resolve) => {
    if (fsmod.existsSync(path.join(dest, '.git'))) {
      execFile('git', ['-C', dest, 'fetch', '--prune', 'origin'], { env, timeout: 90000 }, () => resolve({ ok: true, path: dest }));
      return;
    }
    execFile('gh', ['repo', 'clone', nameWithOwner, dest], { env, timeout: 240000 }, (err, _o, errOut) => {
      if (!err) return resolve({ ok: true, path: dest });
      execFile('git', ['clone', `https://github.com/${nameWithOwner}.git`, dest], { env, timeout: 240000 }, (e2, _o2, e2Out) => {
        if (e2) return resolve({ ok: false, error: 'clone failed: ' + String((errOut || '') + (e2Out || '') || e2.message).slice(0, 300) });
        resolve({ ok: true, path: dest });
      });
    });
  });
}
// per-project tab color from a small palette (hashed by name) so different projects look distinct
const TAB_PALETTE = ['#2f6df0', '#1faa52', '#ef6c33', '#a855f7', '#0ea5e9', '#e0457b', '#b8542b', '#0d9488'];
function tabColor(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return TAB_PALETTE[h % TAB_PALETTE.length]; }
function projTitle(repo) { return (String(repo || '').replace(/\/+$/, '').split('/').pop()) || 'project'; }

// open the config window for a new session (used by ⌘N and the grid's + button)
// the monitor the user is actively on: the display of the focused/most-recent Fleet window, else the cursor's display.
// Used to keep the config window on the SAME screen the user invoked it from (multi-monitor: don't pop on another display).
function activeDisplay() {
  const { screen } = require('electron');
  const ref = BrowserWindow.getFocusedWindow() || anyGridWin();
  return ref ? screen.getDisplayMatching(ref.getBounds())
             : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
function centerOnActiveDisplay(win) {
  const wa = activeDisplay().workArea;
  const [w, h] = win.getSize();
  win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h });
}
function openConfigForNew() {
  if (configWin) { centerOnActiveDisplay(configWin); configWin.show(); configWin.focus(); } else createConfigWindow();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'New Session…', accelerator: 'CmdOrCtrl+N', click: openConfigForNew },
      { type: 'separator' },
      // ⌘W is pane/project-aware in the grid window (handled in the renderer); closes the config window normally
      { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => {
        const fw = BrowserWindow.getFocusedWindow();
        if (fw && wins.has(fw.id)) sendToWin(fw, 'cmd-w');   // pane/project-aware close inside a grid window
        else if (fw) fw.close();
      } },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

function createConfigWindow() {
  configWin = new BrowserWindow({
    width: 540, height: 660, resizable: false, titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0b0d', acceptFirstMouse: true,   // a click that activates the window also hits the control under it
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  centerOnActiveDisplay(configWin);   // open on the monitor the user is on, not the primary display
  configWin.loadFile(path.join(__dirname, 'config.html'));
  configWin.on('closed', () => { configWin = null; if (!gridWindows().length) app.quit(); });
}

app.whenReady().then(() => {
  buildMenu();
  if (process.env.CFLEET_TEST) {
    buildFleet({ autonomous: !!process.env.CFLEET_AUTON, repo: DEFAULT_REPO });
  } else {
    const saved = loadState();
    if (saved && saved.length) {
      const choice = dialog.showMessageBoxSync({
        type: 'question', buttons: ['Restore', 'Start fresh'], defaultId: 0, cancelId: 0,
        message: `Restore ${saved.length} previous fleet session(s)?`,
        detail: 'Reopens the tabs and resumes each Claude conversation where it left off (claude --continue).',
      });
      // fleet dirs of the saved sessions — protected from the sweep on Restore (they're being reopened) and skipped on
      // Start fresh (they're explicitly --clean'd below). Engine derives the same path as ${repo}-fleet-${sid}.
      const savedDirs = saved.map((ss) => `${ss.repo || DEFAULT_REPO}-fleet-${ss.sid}`);
      if (choice === 0) { restoreSessions(saved); gcAll(savedDirs); return; }
      // Start fresh: discard the previous sessions' worktrees so <repo>-fleet-N folders don't pile up
      saved.forEach((ss) => execFile(FLEET_CLI, ['--clean'], { env: Object.assign({}, process.env, { CLAUDE_FLEET_SESSION: String(ss.sid), CLAUDE_FLEET_REPO: ss.repo || DEFAULT_REPO, CLAUDE_FLEET_FORCE: '1' }) }, () => {}));
      clearState();
      gcAll(savedDirs);   // reap any OTHER orphaned finished folders (the saved ones are --clean'd above)
    } else {
      gcAll();            // no prior sessions — sweep any finished folders orphaned by a crash/quit
    }
    createConfigWindow();
  }
});
app.on('activate', () => { if (!configWin && !gridWindows().length) createConfigWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { killAll(); });

// create a grid window (optionally at given bounds for a tear-off) and register it. Returns the BrowserWindow.
function createGridWindow(bounds) {
  const opts = {
    width: 1500, height: 950, backgroundColor: '#141518', show: false,
    titleBarStyle: 'hiddenInset', title: 'Claude Fleet', acceptFirstMouse: true,   // first click from another app hits the pane/button you clicked, not just window focus
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },   // keep rAF/timers running while backgrounded so panes spawn even when you're in another app
  };
  if (bounds) Object.assign(opts, bounds);
  const win = new BrowserWindow(opts);
  const rec = { win, ready: false, queue: [] };
  wins.set(win.id, rec);
  if (lastFocusedGridId == null) lastFocusedGridId = win.id;
  win.loadFile(path.join(__dirname, 'grid.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.webContents.once('did-finish-load', () => { rec.ready = true; rec.queue.splice(0).forEach((fn) => fn()); });
  win.on('focus', () => { lastFocusedGridId = win.id; });
  win.on('close', (e) => onGridClose(win, e));
  win.on('closed', () => onGridClosed(win));
  return win;
}
// red-light close of a grid window. Empty window closes freely; otherwise confirm. With siblings present, the
// closed window's sessions are DISCARDED (kill PTYs + worktrees); if it's the last window we leave them intact so
// will-quit/saveState can offer a restore next launch.
function onGridClose(win, e) {
  if (win._allowClose) return;
  const sids = sessionsInWindow(win);
  if (!sids.length) return;                                  // nothing here -> close freely
  const others = gridWindows().filter((w) => w.id !== win.id);
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning', buttons: ['Cancel', 'Close'], defaultId: 0, cancelId: 0,
    message: others.length ? `Close this window (${sids.length} project${sids.length > 1 ? 's' : ''})?` : 'Close Claude Fleet?',
    detail: others.length
      ? 'Stops these projects’ terminals and removes their worktrees. Projects in your other windows keep running.'
      : 'Stops the running terminals. Your sessions are saved — you can restore them (and resume each Claude conversation) next launch.',
  });
  if (choice !== 1) return;
  win._allowClose = true;
  if (others.length) sids.forEach((sid) => closeSession(sid));   // discard; siblings keep the app alive
  win.close();
}
function onGridClosed(win) {
  wins.delete(win.id);
  activeSidByWin.delete(win.id);   // drop the visible-tab record for the gone window
  if (lastFocusedGridId === win.id) lastFocusedGridId = (gridWindows()[0] || {}).id || null;
  updateBadgeAndTray();
  if (!gridWindows().length && !configWin) { killAll(); app.quit(); }   // no windows left -> quit (state already saved)
}
function closeEmptyWindow(win) { if (win && !win.isDestroyed()) { win._allowClose = true; win.close(); } }

// --- SESSION MIGRATION (tear-off / re-dock / move between windows) -----------------------------
// Move session `sid` from `fromWin` to `toWin`. PTYs are NEVER touched — we only re-point routing and rebuild the
// view: destination rebuilds the tab + panes (re-attaching xterm to the live PTYs), origin disposes its view.
function migrateSession(sid, fromWin, toWin) {
  sid = Number(sid);
  if (!sessions[sid] || !toWin || toWin.isDestroyed() || (fromWin && toWin.id === fromWin.id)) return;
  sidWin.set(sid, toWin.id);                       // re-route all per-sid events to the destination
  rebuildSessionInWindow(sid, toWin);              // build tab + panes there (add-session path), restore dots
  sendToWin(fromWin, 'remove-session', { sid });   // origin drops the tab + disposes xterm views (NOT the PTYs)
  if (fromWin && !sessionsInWindow(fromWin).length) closeEmptyWindow(fromWin);   // no empty windows left behind
  if (toWin.isMinimized()) toWin.restore();
  toWin.show(); toWin.focus();
  updateBadgeAndTray();
}
function rebuildSessionInWindow(sid, win) {
  const s = sessions[sid]; if (!s) return;
  const meta = (s.panes || []).map((p, i) => (p ? { id: i, role: p.role, heading: p.heading } : null)).filter(Boolean);
  if (!meta.length) return;
  sendAddSession(sid, s.title, s.color, meta, s.mode, win, true);   // migrated: destination force-refreshes to clear reflow striping
  if (s.pstate) Object.keys(s.pstate).forEach((idx) => {       // restore each pane's current status dot
    const st = s.pstate[idx] && s.pstate[idx].state; if (st) sendToWin(win, 'pane-state', { sid, id: +idx, state: st });
  });
}

// hit-test: is the screen point (sx,sy) over `win`'s tab bar strip?
const TABBAR_H = 38;   // must match #tabbar height in grid.html
function pointInTabbar(win, sx, sy) {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
  const b = win.getContentBounds();
  return sx >= b.x && sx <= b.x + b.width && sy >= b.y && sy <= b.y + TABBAR_H;
}

// --- DRAG VISUALS: a follower chip that tracks the cursor + a drop-target highlight on the hovered bar.
// Best-effort and purely cosmetic — wrapped so a failure can never block the actual drag/migration.
let follower = null, hovered = null;
function cssColor(c) { return /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#2f6df0'; }
function startFollower(info) {
  endDragVisuals();
  try {
    follower = new BrowserWindow({
      width: 190, height: 34, frame: false, transparent: true, hasShadow: false, resizable: false,
      movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, webPreferences: {},
    });
    follower.setIgnoreMouseEvents(true);   // never intercept the cursor — origin window keeps mouse capture
    const title = String((info && info.title) || 'tab').replace(/[<>&]/g, '');
    const html = `<body style="margin:0;overflow:hidden;font:600 12px -apple-system,system-ui,sans-serif;">`
      + `<div style="height:34px;display:flex;align-items:center;gap:7px;padding:0 13px;border-radius:8px;`
      + `background:${cssColor(info && info.color)};color:#fff;box-shadow:0 10px 26px rgba(0,0,0,.5);`
      + `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">`
      + `<span style="width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.9);flex:none;"></span>${title}</div></body>`;
    follower.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    follower.once('ready-to-show', () => { if (follower && !follower.isDestroyed()) follower.showInactive(); });
  } catch (_) { follower = null; }
}
function moveFollower(e, sx, sy) {
  if (follower && !follower.isDestroyed()) { try { follower.setPosition(Math.round(sx - 18), Math.round(sy - 14)); if (!follower.isVisible()) follower.showInactive(); } catch (_) {} }
  const fromWin = BrowserWindow.fromWebContents(e.sender);
  const tgt = gridWindows().find((w) => (!fromWin || w.id !== fromWin.id) && pointInTabbar(w, sx, sy)) || null;
  if (tgt !== hovered) {
    if (hovered && !hovered.isDestroyed()) sendToWin(hovered, 'tabbar-highlight', { on: false });
    hovered = tgt;
    if (hovered) sendToWin(hovered, 'tabbar-highlight', { on: true });
  }
}
function endDragVisuals() {
  if (follower && !follower.isDestroyed()) { try { follower.close(); } catch (_) {} }
  follower = null;
  if (hovered && !hovered.isDestroyed()) sendToWin(hovered, 'tabbar-highlight', { on: false });
  hovered = null;
}

function sendAddSession(sid, title, color, meta, mode, win, migrated) {
  const { cols, rows } = gridDims(meta.length);
  const payload = { sid, title, color, cols, rows, panes: meta, mode: mode || 'dispatch', migrated: !!migrated };
  const target = win || winForSid(sid);
  if (target) sidWin.set(Number(sid), target.id);   // record which window hosts this session
  sendToWin(target, 'add-session', payload);
}

async function buildFleet({ autonomous, repo, nameWithOwner, defaultBranch, account, orchestrator, count, names, newProject }) {
  if (!pty) { if (configWin) configWin.webContents.send('launch-error', 'node-pty failed to load — run `npm run rebuild`.'); return { ok: false, error: 'node-pty not loaded' }; }
  const useOrch = orchestrator !== false;   // default ON (orchestrator); OFF = named worker panes you task directly
  // resolve the project: a NEW-PROJECT scratch repo (no folder picked yet), a GitHub repo (clone to ~/Developer/<repo>
  // if missing, then fetch), or a local folder.
  let repoPath, scratch = false, sid;
  if (newProject) {
    // launch with NOTHING selected: boot the orchestrator in a throwaway scratch repo. The user tells Claude what to
    // build, Claude derives a name, and the CLI writes a .retarget marker → we tear this down and launch on ~/Developer/<name>.
    sid = nextSid++;
    repoPath = path.join(os.homedir(), 'Developer', `.cfleet-scratch-${sid}`);
    try { initGitRepo(repoPath, { empty: true }); }
    catch (e) { nextSid--; return { ok: false, error: 'scratch init failed: ' + ((e && e.message) || e) }; }
    scratch = true;
  } else if (nameWithOwner) {
    const ens = await ensureRepoClone(nameWithOwner, defaultBranch, account);
    if (!ens.ok) return { ok: false, error: ens.error };
    repoPath = ens.path;
  } else {
    repoPath = repoFor(repo);
    if (!fsmod.existsSync(path.join(repoPath, '.git'))) {   // a local folder is fine — it just has to be a git repo (fleet uses worktrees)
      const choice = dialog.showMessageBoxSync(configWin || anyGridWin(), {
        type: 'question', buttons: ['Initialize git here', 'Cancel'], defaultId: 0, cancelId: 1,
        message: 'This folder isn’t a git repository yet.',
        detail: `Claude Fleet isolates each worker in a git worktree, so the project must be a git repo.\n\nInitialize one in:\n${repoPath}\n\n(adds a basic .gitignore if missing, then makes one initial commit of the current files)`,
      });
      if (choice !== 0) return { ok: false, error: 'Cancelled — pick a folder that is a git repo, or let it initialize one.' };
      try { initGitRepo(repoPath); }
      catch (e) { return { ok: false, error: 'git init failed: ' + ((e && e.message) || e) }; }
    }
  }
  // no-orchestrator mode: named worker panes you task directly (each pushes itself) — needs at least one name
  let gyNames = [];
  if (!useOrch) {
    gyNames = (names || []).slice(0, count || 0).map((n, i) => (n && n.trim()) || ('Pane ' + (i + 1)));
    if (!gyNames.length) return { ok: false, error: 'Name at least one worker pane.' };
  }
  if (sid == null) sid = nextSid++;   // newProject already reserved its sid above (for the scratch dir name)
  const title = scratch ? 'New project' : projTitle(repoPath);           // tab = the repo name (don't show .cfleet-scratch-N)
  const color = account ? accountColor(account) : tabColor(title);
  sessions[sid] = {
    repo: repoPath, title, color,
    mode: useOrch ? 'dispatch' : 'grid',   // 'grid' = named-worker grid (enables the live + Pane button)
    bypass: !useOrch,                            // grid workers push themselves → broad allowlist incl. push
    autonomous: useOrch ? !!autonomous : true,
    newProject: scratch,                          // scratch session: orchestrator boots with CLAUDE_FLEET_NEW_PROJECT=1; retargets on .retarget
    panes: [], planReady: false, pending: {}, slugIdx: {},
    statusDir: path.join(`${repoPath}-fleet-${sid}`, '.status'),   // matches engine FLEET=${REPO}-fleet-${SESSION}
    watcher: null,
  };
  const win = targetGridWin();   // new session lands in the focused/last grid window (or a fresh one)
  sidWin.set(sid, win.id);
  updatePowerBlocker();   // a fleet is now running — keep the app awake in the background
  if (configWin) configWin.hide();
  const onReady = (panes) => {
    const s = sessions[sid]; if (!s) return;
    s.panes = panes; s.planReady = true;
    panes.forEach((p, i) => { if (p.slug) s.slugIdx[p.slug] = i; });
    Object.keys(s.pending).forEach((idx) => spawnPane(sid, +idx, s.pending[idx].cols, s.pending[idx].rows));
    startWatcher(sid);
    saveState();
    updateBadgeAndTray();   // show this fleet in the menu-bar tray right away
  };
  const onErr = (err) => sendToSid(sid, 'fleet-error', { sid, msg: String(err.message || err) });
  if (useOrch) {
    sendAddSession(sid, title, color, [{ id: 0, role: 'orchestrator', heading: 'Orchestrator' }], 'dispatch', win);  // solo orchestrator; spawns its own workers
    runOrchestrator(sid, repoPath).then(onReady).catch(onErr);
  } else {
    sendAddSession(sid, title, color, gyNames.map((n, i) => ({ id: i, role: 'worker', heading: n })), 'grid', win);  // named worker panes
    runGridPlan(count, gyNames, sid, repoPath).then(onReady).catch(onErr);
  }
  return { ok: true };
}

// rebuild saved sessions into the grid and resume each pane (claude --continue) in its existing worktree
function restoreSessions(saved) {
  const win = createGridWindow();   // all restored tabs reopen in a single window
  let maxSid = 0;
  saved.forEach((ss) => {
    const panes = (ss.panes || []).filter((p) => p && p.dir && fsmod.existsSync(p.dir));   // skip panes whose worktree is gone
    if (!panes.length) return;
    const sid = ss.sid; maxSid = Math.max(maxSid, sid);
    const title = ss.title || projTitle(ss.repo), color = ss.color || tabColor(title);
    const s = {
      repo: ss.repo, title, color, mode: ss.mode || 'dispatch', bypass: !!ss.bypass, autonomous: !!ss.autonomous, panes: [], planReady: true,
      pending: {}, slugIdx: {}, statusDir: path.join(`${ss.repo}-fleet-${sid}`, '.status'), watcher: null,
    };
    panes.forEach((p) => { s.panes[p.id] = { role: p.role, slug: p.slug, heading: p.heading, dir: p.dir, prompt: '', resume: true }; if (p.slug) s.slugIdx[p.slug] = p.id; });
    sessions[sid] = s;
    sendAddSession(sid, title, color, panes.map((p) => ({ id: p.id, role: p.role, heading: p.heading })), s.mode, win);
    startWatcher(sid);
  });
  nextSid = Math.max(nextSid, maxSid + 1);
  updatePowerBlocker();
  updateBadgeAndTray();
  if (!Object.keys(sessions).length) { closeEmptyWindow(win); createConfigWindow(); }   // nothing valid left to restore
}

function runOrchestrator(sid, repo) {
  return new Promise((resolve, reject) => {
    execFile(FLEET_CLI, ['--orchestrator'], { maxBuffer: 16 * 1024 * 1024, env: sessionEnv(sid, repo) }, (err, out, errOut) => {
      if (err) return reject(new Error((errOut && errOut.trim()) || err.message));
      try { const p = JSON.parse(out); if (!Array.isArray(p) || !p.length) throw new Error('empty'); resolve(p); } catch (e) { reject(e); }
    });
  });
}

function runGridPlan(count, names, sid, repo) {
  return new Promise((resolve, reject) => {
    execFile(FLEET_CLI, ['--grid-plan', String(count), ...names], { maxBuffer: 16 * 1024 * 1024, env: sessionEnv(sid, repo) }, (err, out, errOut) => {
      if (err) return reject(new Error((errOut && errOut.trim()) || err.message));
      try { const p = JSON.parse(out); if (!Array.isArray(p) || !p.length) throw new Error('empty plan'); resolve(p); } catch (e) { reject(e); }
    });
  });
}

ipcMain.handle('launch-fleet', (_e, cfg) => buildFleet(cfg));

// ── GitHub accounts (gh multi-account) ───────────────────────────────────────────────────────────────────────
// List connected gh accounts by parsing `gh auth status`. Each block: "Logged in to github.com account <user>" then
// "- Active account: true|false". (gh writes status to stderr in some versions, so we read both streams.)
ipcMain.handle('gh-accounts', () => new Promise((resolve) => {
  execFile('gh', ['auth', 'status'], { env: cmdEnv(), timeout: 15000 }, (_err, out, errOut) => {
    const text = String(out || '') + '\n' + String(errOut || '');
    const accounts = []; let last = null;
    text.split('\n').forEach((line) => {
      const m = line.match(/Logged in to \S+ account (\S+)/);
      if (m) { last = { user: m[1], active: false }; accounts.push(last); return; }
      if (last && /Active account:\s*true/i.test(line)) last.active = true;
    });
    resolve({ accounts });
  });
}));

// Connect a new account: drive `gh auth login --web` in a PTY (TTY = reliable interactive output), parse the
// XXXX-XXXX one-time code, push it to the config window for the device-code modal, auto-answer gh's prompts, and
// resolve on exit. Browser opening is handled by gh itself (and the modal offers a fallback "Open" button).
// Connect a new account via the GitHub OAuth DEVICE FLOW, called directly against GitHub's API (no `gh auth login`
// process to drive/kill — so a Cancel can never corrupt gh's config, and the code always comes straight from the API
// response). We reuse the GitHub CLI's public device-flow client id (the same one `gh auth login` uses). The token is
// handed to gh ONLY at the very end via `gh auth login --with-token` (an atomic write we never interrupt).
const GH_CLIENT_ID = 'Iv1.b507a08c87ecfe98';   // GitHub CLI's public OAuth client id (device flow)
function ghApiPost(reqPath, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({ host: 'github.com', path: reqPath, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'claude-fleet' } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}
function storeGhToken(token) {   // hand the token to gh (atomic write; never killed)
  return new Promise((resolve) => {
    const p = execFile('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'],
      { env: cmdEnv() }, (err) => resolve(!err));
    try { p.stdin.write(token + '\n'); p.stdin.end(); } catch (_) {}
  });
}
let ghPollAbort = null;
ipcMain.handle('gh-connect', async () => {
  try {
    const dev = await ghApiPost('/login/device/code', { client_id: GH_CLIENT_ID, scope: 'repo read:org gist workflow' });
    if (!dev || !dev.device_code) return { ok: false, error: (dev && (dev.error_description || dev.error)) || 'could not start device flow' };
    if (configWin) configWin.webContents.send('gh-device-code', dev.user_code);
    let interval = ((dev.interval || 5) + 1) * 1000;
    const expiry = Date.now() + (dev.expires_in || 900) * 1000;
    let aborted = false; ghPollAbort = () => { aborted = true; };
    while (!aborted && Date.now() < expiry) {
      await new Promise((r) => setTimeout(r, interval));
      if (aborted) break;
      const tok = await ghApiPost('/login/oauth/access_token', { client_id: GH_CLIENT_ID, device_code: dev.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (tok && tok.access_token) { ghPollAbort = null; const ok = await storeGhToken(tok.access_token); return ok ? { ok: true } : { ok: false, error: 'authorized, but saving the token to gh failed' }; }
      if (tok && tok.error === 'slow_down') { interval += 5000; continue; }
      if (tok && tok.error && tok.error !== 'authorization_pending') { ghPollAbort = null; return { ok: false, error: tok.error_description || tok.error }; }
    }
    ghPollAbort = null;
    return { ok: false, error: aborted ? 'cancelled' : 'timed out waiting for authorization' };
  } catch (e) { ghPollAbort = null; return { ok: false, error: String((e && e.message) || e) }; }
});

// Cancel an in-flight connect (user closed the modal): just stop polling. No process is killed, so gh's config is safe.
ipcMain.handle('gh-connect-cancel', () => { try { ghPollAbort && ghPollAbort(); } catch (_) {} ghPollAbort = null; return true; });

// Disconnect an account.
ipcMain.handle('gh-disconnect', (_e, account) => new Promise((resolve) => {
  execFile('gh', ['auth', 'logout', '--hostname', 'github.com', '--user', String(account)], { env: cmdEnv(), timeout: 15000 },
    (err, _o, errOut) => resolve(err ? { ok: false, error: (errOut && errOut.trim()) || err.message } : { ok: true }));
}));

// open an external URL in the default browser (device-code "Open" fallback).
ipcMain.handle('open-external', (_e, url) => { try { shell.openExternal(String(url)); } catch (_) {} return true; });

// list every repo for a GitHub account via gh — includes private repos. Scoped to that account's token so it works
// without changing the user's globally-active gh account.
ipcMain.handle('list-account-repos', async (_e, account) => {
  const token = await ghTokenFor(account);
  return new Promise((resolve) => {
    execFile('gh', ['repo', 'list', String(account), '--limit', '100', '--json', 'nameWithOwner,name,defaultBranchRef,visibility,pushedAt'],
      { env: ghEnv(token), timeout: 25000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) return resolve({ error: (errOut && errOut.trim()) || err.message });
        try {
          const repos = JSON.parse(out).map((r) => ({
            nameWithOwner: r.nameWithOwner, name: r.name,
            defaultBranch: (r.defaultBranchRef && r.defaultBranchRef.name) || 'main', visibility: r.visibility,
          }));
          resolve({ repos });
        } catch (_) { resolve({ error: 'could not parse gh output' }); }
      });
  });
});

// Grid mode: add one more named worker to a running session (no restart). Engine creates a fresh
// worktree+branch off origin/main and emits the pane spec; we push it as a new pane (term-ready -> spawnPane).
function addGridWorker(sid, name) {
  const s = sessions[sid];
  if (!s || s.mode !== 'grid') return Promise.resolve({ ok: false, error: 'not a grid session' });
  if (!s.planReady) return Promise.resolve({ ok: false, error: 'session is still starting — try again in a moment' });
  const nm = String(name || '').trim();
  if (!nm) return Promise.resolve({ ok: false, error: 'name required' });
  return new Promise((resolve) => {
    execFile(FLEET_CLI, ['--grid-add', nm], { maxBuffer: 16 * 1024 * 1024, env: sessionEnv(sid, s.repo) }, (err, out, errOut) => {
      if (err) return resolve({ ok: false, error: (errOut && errOut.trim()) || err.message });
      let info; try { info = JSON.parse(out); } catch (_) { return resolve({ ok: false, error: 'bad plan output' }); }
      if (!info || info.slug == null || s.slugIdx[info.slug] != null) return resolve({ ok: false, error: 'duplicate or invalid worker' });
      const idx = s.panes.length;
      s.panes.push({ role: 'worker', slug: info.slug, heading: info.heading, dir: info.dir, prompt: info.prompt });
      s.slugIdx[info.slug] = idx;
      sendToSid(sid, 'add-pane', { sid, pane: { id: idx, role: 'worker', heading: info.heading } });
      saveState();
      resolve({ ok: true, heading: info.heading });
    });
  });
}
ipcMain.handle('add-grid-worker', (_e, { sid, name }) => addGridWorker(sid, name));
ipcMain.handle('pick-folder', async () => {
  const win = configWin || focusedGridWin() || anyGridWin();
  const r = await dialog.showOpenDialog(win, { title: 'Choose project folder', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use this project' });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});
ipcMain.on('resize-window', (_e, h) => { if (configWin && h > 0) { const [w] = configWin.getSize(); configWin.setSize(w, Math.ceil(h)); } });
ipcMain.on('new-session', openConfigForNew);
ipcMain.on('close-session', (_e, sid) => closeSession(sid));
ipcMain.on('close-pane', (_e, { sid, id }) => {
  const t = ptys[`${sid}:${id}`];
  if (t) { try { t.kill(); } catch (_) {} delete ptys[`${sid}:${id}`]; delete ptyBuf[`${sid}:${id}`]; }
  const s = sessions[sid]; if (s && s.panes && s.panes[id]) s.panes[id] = null;  // null -> spawnPane won't respawn on a stray term-ready
  clearPaneState(sid, id);   // keep the dock badge + tray accurate
  saveState();
});

// confirmation before a destructive close (tab/pane) — returns true to proceed
ipcMain.handle('confirm-close', (e, { kind, name }) => {
  const m = kind === 'session'
    ? { message: name ? `Close project “${name}”?` : 'Close this project?', detail: 'Ends all its Claude terminals and removes its worktrees.' }
    : { message: name ? `Close “${name}”?` : 'Close this pane?', detail: 'Ends this Claude terminal.' };
  const choice = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(e.sender) || anyGridWin(), {
    type: 'warning', buttons: ['Cancel', 'Close'], defaultId: 0, cancelId: 0, ...m,
  });
  return choice === 1;
});

// --- TAB TEAR-OFF / RE-DOCK / MOVE (multi-window) ----------------------------------------------
// Renderer handled reorder-within-the-bar itself; anything that LEFT the bar arrives here with the drop's SCREEN
// point. Over another grid window's tab bar -> dock into it; otherwise -> tear off into a new window at the point.
ipcMain.handle('tab-drop', (e, { sid, screenX, screenY }) => {
  endDragVisuals();
  const fromWin = BrowserWindow.fromWebContents(e.sender);
  if (!fromWin || sidWin.get(Number(sid)) !== fromWin.id || !sessions[Number(sid)]) return { ignored: true };
  const target = gridWindows().find((w) => w.id !== fromWin.id && pointInTabbar(w, screenX, screenY));
  if (target) { migrateSession(sid, fromWin, target); return { docked: true }; }       // dropped on another window's bar
  const b = fromWin.getBounds();
  const nw = createGridWindow({ x: Math.round(screenX - 140), y: Math.round(screenY - 16), width: b.width, height: b.height });
  migrateSession(sid, fromWin, nw);                                                     // tear off into a fresh window
  return { torn: true };
});
// renderer's window has no sessions left after a × close — close it (a sibling carries the app) or, if it's the
// only window, keep it open and offer a new session (legacy single-window behavior)
ipcMain.on('last-tab-closed', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender); if (!win) return;
  if (gridWindows().filter((w) => w.id !== win.id).length) closeEmptyWindow(win);
  else openConfigForNew();
});
// renderer reports the tab now visible in its window (null = no visible session) — tracked for focus routing
ipcMain.on('active-session', (e, sid) => {
  const win = BrowserWindow.fromWebContents(e.sender); if (!win) return;
  if (sid == null) activeSidByWin.delete(win.id);
  else activeSidByWin.set(win.id, Number(sid));
});
ipcMain.on('tab-drag-start', (_e, info) => startFollower(info));
ipcMain.on('tab-drag-move', (e, { screenX, screenY }) => moveFollower(e, screenX, screenY));
ipcMain.on('tab-drag-end', () => endDragVisuals());

// --- file manager / editor: browse + edit files in this session's worktrees (+ repo), scoped for safety ---
function sessionRoots(sid) {
  const s = sessions[sid]; if (!s) return [];
  const roots = [];
  (s.panes || []).forEach((p) => { if (p && p.dir && !roots.find((r) => r.path === p.dir)) roots.push({ label: p.heading || p.slug || 'worktree', path: p.dir }); });
  if (s.repo && !roots.find((r) => r.path === s.repo)) roots.push({ label: 'repo · ' + path.basename(s.repo), path: s.repo });
  return roots;
}
function pathAllowed(sid, target) {
  const real = path.resolve(String(target || ''));
  return sessionRoots(sid).some((r) => { const root = path.resolve(r.path); return real === root || real.startsWith(root + path.sep); });
}
ipcMain.handle('fs-roots', (_e, sid) => sessionRoots(sid));
ipcMain.handle('fs-list', (_e, { sid, dir }) => {
  try {
    if (!pathAllowed(sid, dir)) return { error: 'path not allowed' };
    const entries = fsmod.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
      .map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { entries };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('fs-read', (_e, { sid, file }) => {
  try {
    if (!pathAllowed(sid, file)) return { error: 'path not allowed' };
    if (fsmod.statSync(file).size > 2 * 1024 * 1024) return { error: 'file too large to edit (>2MB)' };
    const buf = fsmod.readFileSync(file);
    if (buf.includes(0)) return { error: 'binary file — not editable here' };
    return { content: buf.toString('utf8') };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('fs-write', (_e, { sid, file, content }) => {
  try {
    if (!pathAllowed(sid, file)) return { error: 'path not allowed' };
    fsmod.writeFileSync(file, content, 'utf8');
    return { ok: true };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});

// audible ping when a permission prompt appears in the overlay (system-wide, even when another app is frontmost)
function playPermSound() {
  try { execFile('afplay', ['/System/Library/Sounds/Submarine.aiff'], { env: cmdEnv() }, () => {}); } catch (_) {}
}

// scoped Node fallback grep when ripgrep isn't installed — walk the root, match lines, cap results
function nodeGrep(root, q, cap) {
  const out = [], ql = q.toLowerCase();
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out', '.cache']);
  const walk = (dir) => {
    if (out.length >= cap) return;
    let ents; try { ents = fsmod.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const d of ents) {
      if (out.length >= cap) return;
      if (SKIP.has(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { walk(p); continue; }
      try {
        if (fsmod.statSync(p).size > 1024 * 1024) continue;
        const buf = fsmod.readFileSync(p); if (buf.includes(0)) continue;   // skip binary
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(ql)) { out.push(`${p}:${i + 1}:${lines[i].trim()}`); if (out.length >= cap) break; }
        }
      } catch (_) {}
    }
  };
  walk(root);
  return out;
}

// search file CONTENTS under a scoped root (the Files sidebar's global search). Prefers ripgrep, falls back to nodeGrep.
ipcMain.handle('fs-search', (_e, { sid, root, query }) => {
  return new Promise((resolve) => {
    try {
      const q = String(query || '').trim();
      if (!q) return resolve({ results: [] });
      if (!pathAllowed(sid, root)) return resolve({ error: 'path not allowed' });
      const CAP = 300;
      const parse = (lines) => lines.filter(Boolean).slice(0, CAP).map((ln) => {
        const m = ln.match(/^(.*?):(\d+):(.*)$/);
        return m ? { file: m[1], line: +m[2], text: m[3].slice(0, 200) } : null;
      }).filter(Boolean);
      execFile('rg', ['--line-number', '--no-heading', '--color', 'never', '-i', '--max-count', '20', '-e', q, root],
        { maxBuffer: 8 * 1024 * 1024, timeout: 8000 }, (err, out) => {
          if (err && err.code === 'ENOENT') return resolve({ results: parse(nodeGrep(root, q, CAP)) });   // no ripgrep
          // rg exits 1 on "no matches" with empty stdout — that's fine, not an error
          resolve({ results: parse(String(out || '').split('\n')) });
        });
    } catch (e) { resolve({ error: String((e && e.message) || e) }); }
  });
});

// --- per-pane STATE MACHINE → drives the in-app dots, the menu-bar tray, and notifications ---
function stripAnsi(s) { return String(s).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B[\]P][\s\S]*?(\x07|\x1B\\)/g, ''); }
// permission prompt = a numbered "Yes" option AND one of Claude Code's prompt markers (robust to wording / box layout)
const PERM_YES = /\b1\.\s*Yes\b/i;
const PERM_MARK = /(Do you want to|Would you like to|Esc to cancel|don'?t ask again)/i;
function isPermPrompt(buf) { return PERM_YES.test(buf) && PERM_MARK.test(buf); }
const DONE_RE = /Marked\s+".*?"\s+done\b/i;       // a worker ran `claude-fleet --done`
const FAILED_RE = /Marked\s+".*?"\s+FAILED\b/i;   // a worker ran `claude-fleet --failed`
const PERM_LOG = path.join(os.tmpdir(), 'cfleet-perm.log');
function permLog(msg) { try { fsmod.appendFileSync(PERM_LOG, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (_) {} }
// AppleScript fallback — shows a banner even if Electron's signed-notification path is unavailable (no buttons though)
function osNotify(title, body) {
  const q = (x) => '"' + String(x).replace(/["\\]/g, '').replace(/\s+/g, ' ').trim() + '"';
  try { execFile('osascript', ['-e', `display notification ${q(body)} with title ${q(title)} sound name "Submarine"`], { env: cmdEnv() }, () => {}); } catch (_) {}
}
const IDLE_DOT_MS = 6000;       // quiet this long → flip working→idle (drives dot/tray)
const IDLE_NOTIFY_MS = 25000;   // only notify "idle · ready" after a LONGER quiet (avoids between-phase noise)
const STATE_LABEL = { permission: 'needs permission', failed: 'failed', idle: 'idle · ready', working: 'working' };
function nameOf(s, idx) { const p = s.panes[idx]; return (p && p.heading) || 'A pane'; }
function paneRec(s, idx) { if (!s.pstate) s.pstate = {}; if (!s.pstate[idx]) s.pstate[idx] = { state: 'working', last: Date.now(), idleNotified: false }; return s.pstate[idx]; }

function setPaneState(sid, idx, state) {
  const s = sessions[sid]; if (!s || !s.panes[idx]) return;
  const r = paneRec(s, idx);
  if (r.state === state) return;
  r.state = state;
  r.idleNotified = false;
  if (state === 'idle') r.idleSince = Date.now();
  const w = winForSid(sid);
  permLog('state ' + sid + ':' + idx + ' -> ' + state + ' focused=' + !!(w && w.isFocused()));
  sendToSid(sid, 'pane-state', { sid, id: idx, state });   // drives the in-app dot, in the window hosting this sid
  updateBadgeAndTray();
  // in-app permission QUEUE: add a card when a pane needs permission, remove it once it's no longer waiting.
  // Multiple concurrent prompts stack as a dismissible list in the renderer (each routes back to ITS sid:idx).
  const permMsg = (state === 'permission')
    ? { sid, id: idx, name: nameOf(s, idx), title: s.title, options: (s.permOpts && s.permOpts[idx]) || {} }
    : { sid, id: idx, remove: true };
  sendToSid(sid, 'perm-prompt', permMsg);   // in-app per-window queue
  permUpsert(permMsg);                       // system-wide overlay (global across ALL sessions/windows)
  // notify ALWAYS — even when you're looking at THIS session's tab (user wants in-tab pings too)
  if (state === 'permission') notifyPermission(sid, idx);
  else if (state === 'failed') simpleNotify(sid, idx, nameOf(s, idx) + ' failed', s.title + ' · "' + nameOf(s, idx) + '" couldn’t finish.');
  markPaneWorking(s, idx, state === 'working');   // bridge a re-activated (already-integrated) worker to the engine
}
// A worker pane that's already been --merged/--done but picks up a NEW in-pane task goes back to running with NO engine
// status marker until it next runs --done — so --next reports ALL DONE and --statuses shows nothing for it, and an
// orchestrator polling --next thinks the fleet is drained and stops listening mid-task. Bridge it: while such a pane is
// 'working', drop a durable `$STATUS/<slug>.working` the engine counts as ACTIVE; remove it the moment it goes 'idle'
// (or on pty exit). Mirrors the .closed mechanism. Fires often, so it's cheap: only write if absent, only unlink if present.
function markPaneWorking(s, idx, on) {
  const p = s && s.panes[idx];
  if (!p || p.role !== 'worker' || !p.slug || !s.statusDir) return;
  const f = path.join(s.statusDir, `${p.slug}.working`);
  try {
    if (on) { if (!fsmod.existsSync(f)) fsmod.writeFileSync(f, ''); }
    else { if (fsmod.existsSync(f)) fsmod.unlinkSync(f); }
  } catch (_) { /* status dir gone (session torn down) — nothing live to bridge */ }
}
function clearPaneState(sid, idx) { const s = sessions[sid]; if (!s) return; if (s.pstate) delete s.pstate[idx]; if (s.permOpts) delete s.permOpts[idx]; sendToSid(sid, 'perm-prompt', { sid, id: idx, remove: true }); permUpsert({ sid, id: idx, remove: true }); updateBadgeAndTray(); }
// When a worker pane's pty dies (user closed the pane/window, or claude exited) the git worktree stays on disk, so
// the engine's `[ -d "$FLEET/<slug>" ]` liveness guard still thinks the pane is ALIVE — a --handoff to it would write
// a .task no live claude ever reads (the "black hole"). Drop a durable `$STATUS/<slug>.closed` marker the engine can
// see so --handoff fails loudly and --next/--statuses treat the pane as dead. `slug` is captured at spawn time so this
// works even after s.panes[idx] has been nulled on close. A fresh re-spawn of the same slug clears it (see _do_spawn).
function markPaneClosed(statusDir, slug) {
  if (!statusDir || !slug) return;
  try { fsmod.writeFileSync(path.join(statusDir, `${slug}.closed`), ''); } catch (_) { /* status dir gone (session torn down) — nothing live to protect */ }
  try { fsmod.unlinkSync(path.join(statusDir, `${slug}.working`)); } catch (_) { /* a closed pane must not look like it's still working */ }
}
function noteEvent(sid, idx, kind) {   // transient events parsed from engine output
  if (kind === 'failed') { setPaneState(sid, idx, 'failed'); return; }
  if (kind === 'done') { const s = sessions[sid]; if (!s) return; simpleNotify(sid, idx, nameOf(s, idx) + ' finished', s.title + ' · "' + nameOf(s, idx) + '" completed a task.'); }
}
// plain (no-button) notification used for done / failed / idle; falls back to AppleScript if the signed path fails
function simpleNotify(sid, idx, title, body) {
  const focus = () => focusSidPane(sid, idx);
  if (!Notification.isSupported()) { osNotify(title, body); return; }
  const n = new Notification({ title, body, silent: false });
  n.on('click', focus); n.on('failed', () => osNotify(title, body));
  n.show();
  try { if (app.dock) app.dock.bounce('informational'); } catch (_) {}
}
function fleetCounts() {
  const c = { permission: 0, failed: 0, working: 0, idle: 0 };
  Object.values(sessions).forEach((s) => { if (s.pstate) Object.values(s.pstate).forEach((r) => { if (c[r.state] != null) c[r.state]++; }); });
  return c;
}
function updateBadgeAndTray() {
  const c = fleetCounts();
  try { if (app.dock) { const a = c.permission + c.failed; app.dock.setBadge(a > 0 ? String(a) : ''); } } catch (_) {}
  updateTray(c);
}
// menu-bar tray: live counts + a click-to-jump list of every pane and its state
let tray = null;
function updateTray(c) {
  c = c || fleetCounts();
  if (!Object.keys(sessions).length) { if (tray) { try { tray.destroy(); } catch (_) {} tray = null; } return; }
  if (!tray) { try { tray = new Tray(nativeImage.createEmpty()); tray.setToolTip('Claude Fleet'); } catch (_) { return; } }
  const bits = [];
  if (c.permission) bits.push('● ' + c.permission);
  if (c.failed) bits.push('⚠ ' + c.failed);
  if (c.working) bits.push('⚙ ' + c.working);
  if (c.idle) bits.push('◌ ' + c.idle);
  tray.setTitle(bits.length ? bits.join('  ') : 'Fleet');
  const items = [{ label: 'Claude Fleet', enabled: false }, { type: 'separator' }];
  Object.entries(sessions).forEach(([sid, s]) => {
    (s.panes || []).forEach((p, idx) => {
      if (!p) return;
      const st = (s.pstate && s.pstate[idx] && s.pstate[idx].state) || 'working';
      items.push({ label: s.title + ' › ' + p.heading + ' — ' + (STATE_LABEL[st] || st), click: () => focusSidPane(+sid, idx) });
    });
  });
  items.push({ type: 'separator' }, { label: 'Open Claude Fleet', click: () => { const w = winById(lastFocusedGridId) || anyGridWin(); if (w) { w.show(); w.focus(); } } });
  try { tray.setContextMenu(Menu.buildFromTemplate(items)); } catch (_) {}
}
// live state is reported by the renderer (it reads the real screen). Here we only NOTIFY when a pane has been
// idle/waiting for a while (so a brief between-phase pause doesn't ping you).
setInterval(() => {
  const now = Date.now();
  Object.keys(sessions).forEach((sid) => { const s = sessions[sid]; if (!s || !s.pstate) return;
    Object.keys(s.pstate).forEach((idx) => { const r = s.pstate[idx];
    });
  });
}, 3000);
// parse the numbered options from the live prompt so notification buttons map to the RIGHT key (layouts vary:
// "1.Yes 2.No"  vs  "1.Yes 2.Yes,don't-ask 3.No"). Returns the digit to press for yes / always / no.
function parsePermOptions(buf) {
  const lb = buf.toLowerCase();
  const at = Math.max(lb.lastIndexOf('do you want to'), lb.lastIndexOf('would you like to'));
  const region = at >= 0 ? buf.slice(at) : buf.slice(-600);
  const opts = {}; const re = /(\d)\.\s*([^\n\r]+)/g; let m;
  while ((m = re.exec(region))) { const n = +m[1]; if (n >= 1 && n <= 9 && !opts[n]) opts[n] = m[2].trim().toLowerCase(); }
  let yes, always, no;
  Object.keys(opts).forEach((k) => { const n = +k, l = opts[k];
    if (/^no\b/.test(l)) no = n;
    else if (/don'?t ask|and don|,\s*and|always/.test(l)) always = n;
    else if (/^yes/.test(l) && yes == null) yes = n;
  });
  return { yes, always, no };
}
// answer a pane's permission prompt by writing the option digit to its pty (works even from the background).
// The claude TUI menu needs the digit to SELECT then a carriage return to COMMIT — writing the bare digit just
// highlights the option, it never submits. Send them as two separate keystrokes (small gap) so the TUI registers
// the selection before the Enter, instead of one fused write the menu may swallow.
function answerPane(sid, idx, digit) {
  const t = ptys[`${sid}:${idx}`]; if (!t || digit == null) return;
  try { t.write(String(digit)); } catch (_) {}
  setTimeout(() => { try { t.write('\r'); } catch (_) {} }, 60);   // commit the selection
  setPaneState(sid, idx, 'working');   // answered → back to working
}
function notifyPermission(sid, idx) {
  const s = sessions[sid]; if (!s) return;
  const pane = s.panes[idx]; const name = (pane && pane.heading) || 'A pane';
  const title = `${name} needs permission`, body = `${s.title} · "${name}" is asking to proceed.`;
  permLog('notify ' + sid + ':' + idx + ' supported=' + Notification.isSupported());
  if (!Notification.isSupported()) { osNotify(title, body); return; }
  const opt = (s.permOpts && s.permOpts[idx]) || {};
  const actions = [], map = [];   // action index -> option digit
  if (opt.yes != null) { actions.push({ type: 'button', text: 'Yes' }); map.push(opt.yes); }
  if (opt.always != null) { actions.push({ type: 'button', text: 'Always Yes' }); map.push(opt.always); }
  if (opt.no != null) { actions.push({ type: 'button', text: 'No' }); map.push(opt.no); }
  const focus = () => focusSidPane(sid, idx);
  const n = new Notification({ title, body, actions, silent: false });
  n.on('action', (_e, ai) => answerPane(sid, idx, map[ai]));   // tapped a notification button → answer directly
  n.on('click', focus);                                        // tapped the body → jump to the pane
  n.on('show', () => permLog('shown ' + sid + ':' + idx));
  n.on('failed', (_e, err) => { permLog('FAILED ' + err); osNotify(title, body); });   // signed-notif unavailable → AppleScript banner
  n.show();
  try { if (app.dock) app.dock.bounce('informational'); } catch (_) {}
}

function spawnPane(sid, idx, cols, rows) {
  const s = sessions[sid];
  if (!pty || !s || ptys[`${sid}:${idx}`] || !s.panes[idx]) return;
  const p = s.panes[idx];
  // A live pty is starting for this slug → clear any stale `.closed` marker from a prior close/shutdown (e.g. a
  // restored/resumed pane reuses the same slug+worktree without going through the engine's _do_spawn) so the engine
  // doesn't treat this now-alive pane as dead.
  if (p.slug) { try { fsmod.unlinkSync(path.join(s.statusDir, `${p.slug}.closed`)); } catch (_) {} try { fsmod.unlinkSync(path.join(s.statusDir, `${p.slug}.working`)); } catch (_) {} }
  const shell = process.env.SHELL || '/bin/zsh';
  const home = os.homedir();
  const extraPath = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  // Task-aware reasoning effort, per pane (all panes stay Opus). The orchestrator runs xhigh
  // (max reasoning) for heavy coordination/decomposition; workers default to 'high' (faster
  // first output than xhigh) but honor an explicit per-worker effort from the spawn marker
  // ("low"|"medium"|"high"|"xhigh"). This overrides the user's global effort ONLY for fleet
  // panes. Env var is silently ignored if unsupported, so it can't break the launch.
  // Orchestrator defaults to 'high' (not xhigh) for a faster first dispatch — it can still raise a
  // specific worker to xhigh per-task via `claude-fleet --spawn[-file] … --effort xhigh`.
  const effort = (p.role === 'orchestrator') ? 'high' : (p.effort || 'high');
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color', COLORTERM: 'truecolor',
    CLAUDE_FLEET_SESSION: String(sid), CLAUDE_FLEET_REPO: s.repo,   // so the orchestrator's `claude-fleet` calls target THIS project, not the default
    CLAUDE_CODE_EFFORT_LEVEL: effort,
    // share ONE Rust build cache across this session's worktrees (Tauri/cargo) instead of a multi-GB target/ per
    // pane. Lives inside the fleet dir, so it's reclaimed when the session closes. cargo locks it for concurrency.
    CARGO_TARGET_DIR: path.join(`${s.repo}-fleet-${sid}`, '.cargo-target'),
    PATH: extraPath + (process.env.PATH ? ':' + process.env.PATH : ''),
  });
  // new-project scratch session: the CLI emits the new-project brief (name → retarget) when this is set.
  if (s.newProject && p.role === 'orchestrator') env.CLAUDE_FLEET_NEW_PROJECT = '1';
  // Grid workers (no-orchestrator mode) get a BROAD allowlist (incl. push + rm) — each pushes its own area, so it
  // runs with no prompts for normal work AND no --dangerously-skip-permissions accept screen. Truly unusual verbs
  // (curl/sudo/…) still ask. Dispatch mode: scoped allowlist; only the orchestrator may push.
  const dispatchPush = (p.role === 'orchestrator') ? ['Bash(git push:*)'] : [];
  const allowList = s.bypass ? ALLOW.concat(['Bash(git push:*)', 'Bash(rm:*)'])
    : (s.autonomous ? ALLOW.concat(dispatchPush) : null);
  const allowArgs = allowList ? ' --allowedTools ' + allowList.map((a) => shQuote(a)).join(' ') : '';
  // restored panes resume their prior conversation in this worktree (Claude's built-in --continue); fresh panes get the prompt
  const cmd = p.resume ? 'claude --continue' : 'claude ' + shQuote(p.prompt);
  // Workers rarely need external MCP servers (playwright/canva/…); connecting them slows every
  // launch. --strict-mcp-config + no --mcp-config => zero MCP servers. Orchestrator keeps MCP
  // (it may use it for deploys, etc.).
  const mcpArgs = (p.role === 'orchestrator') ? '' : ' --strict-mcp-config';
  let term;
  try {
    term = pty.spawn(shell, ['-l', '-c', `exec ${cmd}${mcpArgs}${allowArgs}`], {
      name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: p.dir, env,
    });
  } catch (e) {   // bad cwd / spawn failure -> surface it instead of leaving the pane stuck on "Starting Claude…"
    sendToSid(sid, 'fleet-error', { sid, msg: 'Failed to start pane: ' + (e && e.message || e) });
    return;
  }
  const key = `${sid}:${idx}`;
  const closedSlug = p.slug, closedStatusDir = s.statusDir;   // captured now: onExit may fire after s.panes[idx] is nulled on close
  ptys[key] = term;
  const ring = ptyBuf[key] = { chunks: [], bytes: 0 };
  term.onData((data) => {
    sendToSid(sid, 'pty-data', { sid, id: idx, data });
    // keep a rolling copy of the raw stream so a tab moved to another window can replay its screen + scrollback
    ring.chunks.push(data); ring.bytes += data.length;
    while (ring.bytes > PTY_BUF_MAX && ring.chunks.length > 1) ring.bytes -= ring.chunks.shift().length;
    // EVENTS only (failed/done). Live working/idle/permission state is reported by the renderer, which reads the
    // actual on-screen text — scanning the raw stream here mis-fired because old spinner text lingered in the buffer.
    const clean = stripAnsi(data);
    if (FAILED_RE.test(clean)) noteEvent(sid, idx, 'failed');
    else if (DONE_RE.test(clean)) noteEvent(sid, idx, 'done');
  });
  term.onExit(() => { sendToSid(sid, 'pty-exit', { sid, id: idx }); delete ptys[`${sid}:${idx}`]; delete ptyBuf[`${sid}:${idx}`]; const ss = sessions[sid]; if (ss) (ss.exited || (ss.exited = {}))[idx] = true; clearPaneState(sid, idx); markPaneClosed(closedStatusDir, closedSlug); });
}

ipcMain.on('term-ready', (_e, { sid, id, cols, rows }) => {
  const s = sessions[sid]; if (!s) return;
  if (s.exited && s.exited[id]) return;   // pane's PTY already ended — a re-attach after a move must NOT relaunch it
  const key = `${sid}:${id}`;
  if (ptys[key]) {   // PTY already alive -> this is a RE-ATTACH (tab torn off / re-docked into another window).
    // Don't relaunch claude. Resize the live PTY to the new view, then replay its buffered stream so the fresh xterm
    // shows the actual session (current screen + scrollback) instead of the "Starting Claude…" placeholder.
    if (cols > 0 && rows > 0) { try { ptys[key].resize(cols, rows); } catch (_) {} }
    const ring = ptyBuf[key];
    if (ring && ring.chunks.length) sendToSid(sid, 'pty-data', { sid, id, data: '\x1b[H\x1b[2J\x1b[3J' + ring.chunks.join('') });
    return;
  }
  if (s.planReady && s.panes[id]) spawnPane(sid, id, cols, rows);
  else s.pending[id] = { cols, rows };
});
ipcMain.on('term-input', (_e, { sid, id, data }) => { const t = ptys[`${sid}:${id}`]; if (t) t.write(data); });
// the renderer reports a pane's live state by reading its actual screen (xterm buffer) — accurate, no stream-lingering
ipcMain.on('pane-activity', (_e, { sid, id, state, screen }) => {
  const s = sessions[sid]; if (!s || !s.panes[id]) return;
  const cur = s.pstate && s.pstate[id] && s.pstate[id].state;
  if (cur === 'failed' && state === 'idle') return;   // a failed pane stays failed while idle; a new 'working' clears it
  if (state === 'permission' && screen) (s.permOpts || (s.permOpts = {}))[id] = parsePermOptions(screen);
  setPaneState(sid, id, state);
});
ipcMain.on('term-resize', (_e, { sid, id, cols, rows }) => { const t = ptys[`${sid}:${id}`]; if (t && cols > 0 && rows > 0) { try { t.resize(cols, rows); } catch (_) {} } });
// renderer answered a queued permission prompt → write the option digit to ITS pty (routes by sid:id, no cross-wiring)
ipcMain.on('answer-pane', (_e, { sid, id, digit }) => answerPane(sid, id, digit));
// overlay clicked a prompt body → jump to that pane (raise its window + focus). Same focus path the notifications use.
ipcMain.on('overlay-focus', (_e, { sid, id }) => focusSidPane(sid, id));

// route text into a pane's input box: bracketed paste so a multiline block lands as ONE block (no early submit on
// embedded newlines), then \r to send it — same mechanism as a real paste/drop (and the .task handoff).
function routeTextToPane(sid, idx, data) {
  const t = ptys[`${sid}:${idx}`]; if (!t) return;
  t.write('\x1b[200~' + String(data).trim() + '\x1b[201~');
  setTimeout(() => { const tt = ptys[`${sid}:${idx}`]; if (tt) tt.write('\r'); }, 250);
}

function startWatcher(sid) {
  const s = sessions[sid]; if (!s) return;
  try {
    s.watcher = fsmod.watch(s.statusDir, (_evt, filename) => {
      if (!filename) return;
      if (filename.endsWith('.spawn')) { handleSpawn(sid, filename); return; }   // orchestrator created a new worker
      if (filename.endsWith('.retarget')) { handleRetarget(sid, filename); return; }   // new-project named → retarget to ~/Developer/<name>
      if (!filename.endsWith('.task')) return;
      const slug = filename.slice(0, -5);
      const full = path.join(s.statusDir, filename);
      fsmod.readFile(full, 'utf8', (err, data) => {
        if (err) return;
        fsmod.unlink(full, () => {});
        const idx = s.slugIdx[slug];
        if (idx != null) routeTextToPane(sid, idx, data);
      });
    });
  } catch (_) { /* status dir not ready */ }
}

// a .spawn marker -> add a worker pane to the grid + spawn its claude on the assigned task
function handleSpawn(sid, filename) {
  const s = sessions[sid]; if (!s) return;
  const full = path.join(s.statusDir, filename);
  fsmod.readFile(full, 'utf8', (err, data) => {
    if (err) return;
    fsmod.unlink(full, () => {});
    let info; try { info = JSON.parse(data); } catch (_) { return; }
    if (info.slug == null || s.slugIdx[info.slug] != null) return;
    const idx = s.panes.length;
    s.panes.push({ role: 'worker', slug: info.slug, heading: info.heading, dir: info.dir, prompt: info.prompt, effort: info.effort });
    s.slugIdx[info.slug] = idx;
    sendToSid(sid, 'add-pane', { sid, pane: { id: idx, role: 'worker', heading: info.heading } });
    saveState();
  });
}

// sanitize a user/Claude-supplied project name into a safe folder slug: kebab-case, strip slashes + leading dots,
// keep [a-z0-9-], collapse/trim dashes. Returns '' if nothing usable is left (caller bails).
function slugifyProjectName(name) {
  return String(name || '')
    .replace(/[\/\\]+/g, '-')         // no path separators — never escape ~/Developer
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')      // everything else → dash
    .replace(/^[-.]+|[-.]+$/g, '')    // strip leading/trailing dashes AND dots (no hidden/'.cfleet-scratch'-ish names)
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

// SAFETY-CRITICAL: tear down ONLY a scratch session for `sid`. Refuses to remove anything whose path doesn't live
// under ~/Developer/.cfleet-scratch- . Done IN-PROCESS (kill PTYs, close watcher, rmSync) — never shells out to
// `claude-fleet --clean` (which could resolve the wrong session and wipe live work).
function teardownScratch(sid) {
  const s = sessions[sid]; if (!s) return;
  const scratchRepo = path.join(os.homedir(), 'Developer', `.cfleet-scratch-${sid}`);
  const scratchFleetDir = `${scratchRepo}-fleet-${sid}`;
  const guard = path.join(os.homedir(), 'Developer', '.cfleet-scratch-');
  // BELT-AND-SUSPENDERS: every path we touch MUST be under the .cfleet-scratch- prefix, or we abort without deleting.
  if (!scratchRepo.startsWith(guard) || !scratchFleetDir.startsWith(guard) || (s.repo && s.repo !== scratchRepo)) {
    console.error('[cfleet] teardownScratch ABORT: path not under .cfleet-scratch- (sid=' + sid + ', repo=' + s.repo + ')');
    return;
  }
  if (s.watcher) { try { s.watcher.close(); } catch (_) {} }
  s.panes.forEach((_p, i) => { const t = ptys[`${sid}:${i}`]; if (t) { try { t.kill(); } catch (_) {} delete ptys[`${sid}:${i}`]; } delete ptyBuf[`${sid}:${i}`]; });
  // remove the scratch worktree dir AND the scratch repo itself — both guarded by the startsWith assertion above
  try { if (scratchFleetDir.startsWith(guard)) fsmod.rmSync(scratchFleetDir, { recursive: true, force: true }); } catch (_) {}
  try { if (scratchRepo.startsWith(guard)) fsmod.rmSync(scratchRepo, { recursive: true, force: true }); } catch (_) {}
  delete sessions[sid];
  sidWin.delete(Number(sid));
  updatePowerBlocker();
  updateBadgeAndTray();
}

// .retarget marker -> the user named the new project. Resolve ~/Developer/<name>, tear down THIS scratch session,
// then launch a NORMAL orchestrator session on the real folder and seed its first input with the goal.
function handleRetarget(sid, filename) {
  const s = sessions[sid]; if (!s) return;
  const full = path.join(s.statusDir, filename);
  fsmod.readFile(full, 'utf8', (err, data) => {
    fsmod.unlink(full, () => {});                       // consume the marker regardless of parse outcome
    if (err) return;
    let info; try { info = JSON.parse(data); } catch (_) { return; }
    const slug = slugifyProjectName(info && info.name);
    if (!slug) return;                                  // unusable name — leave the scratch session running
    const goal = (info && info.goal) || '';
    const dest = path.join(os.homedir(), 'Developer', slug);
    try {
      if (!fsmod.existsSync(dest)) initGitRepo(dest);                              // fresh folder → fresh git repo
      else if (!fsmod.existsSync(path.join(dest, '.git'))) initGitRepo(dest);      // exists but not git → init in place
      // exists + already git → reuse as-is
    } catch (e) { sendToSid(sid, 'fleet-error', { sid, msg: 'Could not set up ' + dest + ': ' + ((e && e.message) || e) }); return; }
    teardownScratch(sid);                               // guarded: only removes the .cfleet-scratch- dirs for THIS sid
    launchOrchestratorSession({ repoPath: dest, title: slug, color: tabColor(slug), autonomous: !!s.autonomous, seedGoal: goal });
  });
}

// launch a plain orchestrator session on an already-resolved repo dir (used by retarget). Mirrors buildFleet's
// orchestrator branch; optionally seeds the new orchestrator pane's first input with `seedGoal` once it spawns.
function launchOrchestratorSession({ repoPath, title, color, autonomous, seedGoal }) {
  if (!pty) return;
  const sid = nextSid++;
  sessions[sid] = {
    repo: repoPath, title, color, mode: 'dispatch', bypass: false, autonomous: !!autonomous, newProject: false,
    panes: [], planReady: false, pending: {}, slugIdx: {},
    statusDir: path.join(`${repoPath}-fleet-${sid}`, '.status'), watcher: null,
    seedGoal: (seedGoal && String(seedGoal).trim()) || '',
  };
  const win = targetGridWin();
  sidWin.set(sid, win.id);
  updatePowerBlocker();
  const onReady = (panes) => {
    const ss = sessions[sid]; if (!ss) return;
    ss.panes = panes; ss.planReady = true;
    panes.forEach((p, i) => { if (p.slug) ss.slugIdx[p.slug] = i; });
    Object.keys(ss.pending).forEach((idx) => spawnPane(sid, +idx, ss.pending[idx].cols, ss.pending[idx].rows));
    startWatcher(sid);
    // seed the orchestrator's first input with the goal so it starts building immediately. Give the freshly-spawned
    // claude a beat to draw its input box; flush if/when its PTY is live (queued in seedGoal until then).
    if (ss.seedGoal) {
      const flush = (tries) => {
        const orchIdx = panes.findIndex((p) => p && p.role === 'orchestrator');
        const i = orchIdx >= 0 ? orchIdx : 0;
        if (ptys[`${sid}:${i}`]) routeTextToPane(sid, i, ss.seedGoal);
        else if (tries > 0) setTimeout(() => flush(tries - 1), 400);
      };
      setTimeout(() => flush(20), 1200);
    }
    saveState();
    updateBadgeAndTray();
  };
  const onErr = (err) => sendToSid(sid, 'fleet-error', { sid, msg: String(err.message || err) });
  sendAddSession(sid, title, color, [{ id: 0, role: 'orchestrator', heading: 'Orchestrator' }], 'dispatch', win);
  runOrchestrator(sid, repoPath).then(onReady).catch(onErr);
}

function closeSession(sid) {
  const s = sessions[sid]; if (!s) return;
  // a scratch (new-project, unnamed) session has no real repo to --clean — tear it down in-process, guarded so it
  // can only ever remove the .cfleet-scratch- dirs (never a live/foreign session). saveState afterward.
  if (s.newProject) { teardownScratch(sid); saveState(); return; }
  if (s.watcher) { try { s.watcher.close(); } catch (_) {} }
  s.panes.forEach((_p, i) => { const t = ptys[`${sid}:${i}`]; if (t) { try { t.kill(); } catch (_) {} delete ptys[`${sid}:${i}`]; } delete ptyBuf[`${sid}:${i}`]; });
  // tear down this session's worktrees in the background (force = no prompt) — target this session's repo/fleet
  execFile(FLEET_CLI, ['--clean'], { env: Object.assign({}, process.env, { CLAUDE_FLEET_SESSION: String(sid), CLAUDE_FLEET_REPO: s.repo || DEFAULT_REPO, CLAUDE_FLEET_FORCE: '1' }) }, () => {});
  delete sessions[sid];
  sidWin.delete(Number(sid));   // drop the routing entry — no stale sid->window mapping after a close
  saveState();   // an explicitly-closed session is discarded — won't be offered for restore
  updatePowerBlocker();   // release the App-Nap blocker if no fleets remain
  updateBadgeAndTray();   // refresh the menu-bar tray (drop this project; remove tray if none left)
}

function killAll() {
  saveState();   // window close / quit preserves sessions + worktrees so they can be restored next launch
  Object.values(ptys).forEach((t) => { try { t.kill(); } catch (_) {} });
  Object.values(sessions).forEach((s) => { if (s.watcher) { try { s.watcher.close(); } catch (_) {} } });
  if (overlayWin && !overlayWin.isDestroyed()) { try { overlayWin.destroy(); } catch (_) {} overlayWin = null; }
  if (tray) { try { tray.destroy(); } catch (_) {} tray = null; }
}

// prevent macOS App Nap from suspending the app (and its background work) while any fleet is running
let psbId = null;
function updatePowerBlocker() {
  const active = Object.keys(sessions).length > 0;
  if (active && (psbId == null || !powerSaveBlocker.isStarted(psbId))) { try { psbId = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) {} }
  else if (!active && psbId != null) { try { powerSaveBlocker.stop(psbId); } catch (_) {} psbId = null; }
}

// paste: clipboard text, or save a clipboard image to temp PNG and return its path
ipcMain.handle('clipboard-read', () => {
  try {
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) { const p = path.join(os.tmpdir(), `cfleet-paste-${Date.now()}.png`); fsmod.writeFileSync(p, img.toPNG()); return { image: p }; }
  } catch (_) {}
  return { text: clipboard.readText() || '' };
});
ipcMain.handle('save-image-bytes', (_e, bytes) => {
  try { const p = path.join(os.tmpdir(), `cfleet-drop-${Date.now()}.png`); fsmod.writeFileSync(p, Buffer.from(bytes)); return p; } catch (_) { return null; }
});
