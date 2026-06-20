# Claude Fleet

Electron desktop app: a multi-mode Claude Code terminal grid. Spawns a grid of
`claude` PTYs, each in its own git worktree, and orchestrates parallel agent work.
Package name `claude-fleet`, v2.0.0. `main` entry = `src/main.js`.

## Build / Run / Test

- `npm start` — launch the app (`electron .`).
- `npm run rebuild` — rebuild the `node-pty` native module against the current
  Electron ABI (`electron-rebuild -f -w node-pty`). **Run this after any
  `npm install` / Electron version bump, or the app fails to load `node-pty`.**
- `npm run dist` — package a macOS app dir via `electron-builder` (target `dir`,
  unsigned, output under `dist/`).
- No automated test suite. Manual smoke test via env flags on `npm start`:
  - `CFLEET_TEST=dispatch [CFLEET_AUTON=1]` — boot straight into a Dispatch session.
  - `CFLEET_TEST=<1..9> [CFLEET_AUTON=1]` — boot a Merge session with N panes.
  - **GOTCHA: the smoke test runs the REAL orchestrator against the configured default repo
    (`DEFAULT_REPO`, the user's home dir unless `CLAUDE_FLEET_REPO` is set) and reuses
    session id 1 (`nextSid` starts at 1).** So it creates/touches `<repo>-fleet-1` — the
    SAME namespace as any pre-existing real session 1. Do NOT `claude-fleet --clean` a
    `<repo>-fleet-N` dir based on its mtime after a smoke test (the test bumps the mtime);
    you can wipe a real session's worktrees/branches. Deleted branches are recoverable from
    their printed SHAs (`git branch <name> <sha>`); worktree dirs are disposable.
  - **NEVER launch the app (`npm start` / `electron .` / `CFLEET_TEST` / `npm run dist`) from
    inside a fleet WORKER or ORCHESTRATOR pane.** A pane runs with `CLAUDE_FLEET_SESSION` set and
    its cwd inside `<repo>-fleet-<sid>/`; launching the app there can trigger `claude-fleet --clean`
    on the LIVE session and `rm -rf` the whole fleet dir (incl. `_main` + uncommitted work). This
    WIPED a live session on 2026-06-18. (`cmd_clean` now self-wipe-guards against it, but don't rely
    on the backstop.) Inside a pane, **verify by STATIC checks ONLY**: `node --check src/main.js`,
    `node --check src/preload.js`, and vm-compile the inline `<script>`s in grid.html / config.html.
  - A real "short timed launch + grep the log" boot check is fine ONLY when run OUTSIDE any fleet
    session (e.g. the user, or a plain dev shell with no `CLAUDE_FLEET_SESSION`) — never from a worker.

## Architecture

Electron, no bundler — plain HTML + vendored libs, loaded directly.

- `src/main.js` — **main process**. Owns windows, PTYs, IPC, and the per-session
  status-dir watcher. `buildFleet()` creates a session; `spawnPane()` spawns a
  `claude` PTY per pane; `startWatcher()` watches `<repo>-fleet-<sid>/.status`
  for `.task` files (route text into a pane) and `.spawn` files (orchestrator added
  a worker → new pane). `ALLOW[]` is the auto-approve allowlist used in autonomous
  mode (`--allowedTools`); push/curl/rm/sudo stay prompted.
- `src/config.html` — config/mode-picker window (renderer). Pick mode, pane count,
  per-pane headings, autonomy. Calls `fleet.launch(cfg)`.
- `src/grid.html` — grid window (renderer). Chrome-style tabbed multi-sessions, the
  xterm grid, drag gutters. Receives `add-session` / `add-pane` / `pty-data`.
- `src/preload.js` — `contextBridge` IPC surface (`window.fleet`). Edit this when
  adding any new main↔renderer channel.
- `src/vendor/` — bundled `@xterm/xterm` + addon-fit + css. Vendored, not from npm
  at runtime; don't import xterm via require in renderer.
- `build/icon.icns` — app icon.

### Two modes (`config.html`, gated by the "Use orchestrator" checkbox)
- **Dispatch** (`mode:'dispatch'`, default, agentic): starts SOLO with one orchestrator
  pane; the orchestrator spawns its own workers on the fly (`--orchestrator`).
- **Grid** (`mode:'grid'`, "Use orchestrator" unchecked): a fixed set of N named worker
  panes you task directly; each owns its area and pushes itself (`--grid-plan`, `--grid-add`).

## The `claude-fleet` CLI (`bin/claude-fleet`)

Bash engine the app shells out to (via `execFile`, `FLEET_CLI`). Drives the whole fleet
lifecycle. It is **bundled in this repo at `bin/claude-fleet`** (and unpacked from the asar
when packaged — see `package.json` `asarUnpack`); `FLEET_CLI` resolves to it. Key env:
`CLAUDE_FLEET_REPO` (project; the app always passes the selected repo),
`CLAUDE_FLEET_SESSION` (namespaces worktrees/branches/status).

- Worktrees live beside the repo at `<repo>-fleet-<session>/`; `_main` is the
  detached orchestrator checkout; workers are `<slug>/` on branch `fleet/s<session>/<slug>`.
- Workers are cut from **`_main`'s HEAD** (latest integrated state), so later-phase
  workers inherit earlier phases. That's why the orchestrator integrates into `_main`.
- Orchestrator subcommands: `--orchestrator`, `--spawn-file H FILE`, `--spawn H TASK`,
  `--handoff T FILE`, `--next` (exit 3 = ALL DONE, 5 = TIMEOUT), `--ready`,
  `--watch`, `--merged S`, `--conflicts`, `--needs` / `--need-clear S`, `--rebuild`,
  `--clean`, `--gc`. Worker-side (run inside a worktree): `--done`, `--failed`, `--need`,
  `--unneed`, `--status`, `--statuses`.
- **Auto-clean / `--gc` (added 2026-06-18):** finished session FOLDERS used to pile up
  forever (`--clean` was manual). `--gc` sweeps `<repo>-fleet*` for the configured repo and
  removes only sessions passing ALL guards: **G0** liveness (`lsof` — skip if any process
  has cwd inside the dir; fail-safe SKIP if `lsof` missing), **G1** not the session you're in,
  **G2** parent repo exists, **G3** every `fleet/s<sid>/*` branch fully merged into main
  (+0), **G4** no worktree dirty. It removes FOLDERS only (folder-merged branches stay). The
  same guarded sweep auto-runs on `--next` ALL DONE (`gc_auto_current` → `gc_sweep_repo`);
  opt out with `CLAUDE_FLEET_NO_AUTOGC=1`. G0 protects EVERY live session (incl. a second app
  window on the same repo), not just the current one — this is the fix for the old
  blind-`--clean` wipe hazard. See [[cfleet-clean-self-wipe-guard]].
- **Robust canonical-main advance (added 2026-06-18):** `advance_canonical_branch` no longer
  REFUSES on a benign non-ff — it auto-runs a `--no-ff` merge of the integrated `_main` HEAD
  into `main` (aborts + refuses loudly only on a REAL conflict), and its "dirty checkout"
  guard now IGNORES a phantom `node_modules` diff (the shared symlink) and untracked
  `.playwright-mcp/` artifacts (`real_porcelain`), so junk can't block integration. Real
  tracked edits still trip the clobber guard. REFUSED messages now print the offending paths
  + the exact reconcile command.

## Conventions / gotchas

- ESM not used; CommonJS `require`. Renderers are plain `<script>` in the HTML.
- Renderer↔main only via `window.fleet` (preload). Never enable nodeIntegration in
  renderers; keep the contextBridge surface minimal.
- PTYs spawn with a login shell: `zsh -l -c 'exec claude <prompt> [--allowedTools …]'`,
  `cwd` = the pane's worktree dir. PATH is augmented with `~/.local/bin` + homebrew.
- Reasoning effort is TASK-AWARE (spawnPane): the orchestrator pane runs `xhigh`;
  worker panes use `p.effort || 'high'`. The orchestrator sets a worker's effort with
  `claude-fleet --spawn[-file] … --effort <low|medium|high|xhigh>`, which the CLI writes
  into the `.spawn` marker (`"effort"` field) → `handleSpawn` → `spawnPane`. Default
  worker = `high` (xhigh forced-everywhere was the old cause of slow "thinking" startups).
- Worker panes launch with `--strict-mcp-config` (no MCP servers) for fast startup; the
  orchestrator pane keeps MCP (it may use it for deploys). Add MCP back to a worker only
  if a task genuinely needs a browser/etc.
- `node-pty` is the one native dep — the usual breakage source after Electron bumps.
- Status-dir IPC is file-based (write `.task` / `.spawn`, watcher consumes + unlinks).
- No `origin` remote on this repo. Integration stays local in `_main`; `git push
  origin HEAD:main` is a no-op here (skip it).
- `~/Developer/claude-fleet-app` is the primary checkout (has `main`) — it's both the
  dev surface AND where the app is launched (`npm start`). The user hand-edits here.
- `.claude-fleet/rebuild` IS configured: after a batch, `claude-fleet --rebuild`
  fast-forwards the live checkout's `main` to the integrated `_main` tip (renderer
  changes show on a NEW session; restart for main-process changes). When the ff
  actually advances, it ALSO repackages the app (`npm run dist`) in the live checkout
  and reinstalls the built bundle into the installed location (existing
  `~/Applications/Claude Fleet.app`, else `/Applications/Claude Fleet.app`, else
  `~/Applications`) — so the user's DOUBLE-CLICKED app isn't stale; they must QUIT +
  REOPEN it to pick up the new build. The repackage is SKIPPED on the no-op/already-at-tip
  path and is NON-FATAL (a `npm run dist`/install failure just warns; ff + integration
  still succeed). It REFUSES if the live checkout has uncommitted edits (won't clobber).
  So before a fleet batch you expect to land live, the user's primary tree should be
  committed/clean. If `--rebuild` reports it skipped due to uncommitted changes, tell
  the user to commit/stash there.
- **ORDERING GOTCHA (`--merged` before `--rebuild` skips the repackage):** `--merged`'s
  `advance_canonical_branch` ALSO fast-forwards the live checkout's `main` to the integrated
  tip. So if you run `--merged` first, by the time `--rebuild` runs the live `main` is already
  at the tip → `--rebuild` hits the no-op/already-at-tip path and SKIPS the `.app` repackage.
  Result: canonical main advances but the user's installed bundle stays STALE (bad for
  main-process changes, since they run the packaged app). FIX: run `claude-fleet --rebuild`
  BEFORE `claude-fleet --merged`. RECOVERY if you already ran `--merged`: rewind the live
  checkout one commit (`git -C ~/Developer/claude-fleet-app reset --hard <prev-tip>`, it's
  clean since the ff required it) then re-run `claude-fleet --rebuild` — it ff's back to the
  same tip and fires the repackage; net tree state is identical.
