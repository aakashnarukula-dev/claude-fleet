# Claude Fleet

Electron desktop app: a multi-mode Claude Code terminal grid. Spawns a grid of
`claude` PTYs, each in its own git worktree, and orchestrates parallel agent work.
Package name `claude-fleet`, v2.0.0. `main` entry = `src/main.js`.

## Installing on a fresh Mac — "clone and install the app" (READ FIRST)

When the user says **"clone this repo and install the app"**, they mean: produce a
**double-clickable `Claude Fleet.app` in `/Applications`** — NOT just `npm install`.
`npm install` only makes it runnable from source (`npm start`); it does NOT create an
app in `/Applications`. Do BOTH: set up the source, then package + install the bundle.
This is a desktop (Electron) app, so it CAN and SHOULD become an `/Applications` app.

### Environment gotchas (verified on this Mac, 2026-07)
- **Clone with `gh`.** This repo is private; `git clone https://…` fails ("could not
  read Username") and no SSH keys exist. Use `gh repo clone aakashnarukula-dev/claude-fleet`
  (the `gh` CLI is installed + authed as `aakashnarukula-dev`).
- **Use Node 22 LTS for ALL build/tooling, not the default `node`.** The system `node`
  on PATH may be too new (v26+), which breaks `electron-rebuild`/`electron-builder`
  (`ReferenceError: require is not defined in ES module scope`). Node 22 LTS lives at
  `/opt/homebrew/opt/node@22/bin` — prepend it: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
  (install once with `brew install node@22`).
- **npm blocks package install scripts.** npm 11/12 skips `postinstall` by default. This
  repo now commits an `allowScripts` field in `package.json` for `electron` + `node-pty`,
  so a normal `npm install` runs them. If you still see "packages have install scripts not
  yet covered by allowScripts", run `npm approve-scripts electron node-pty`.
- **Electron postinstall may not finish → `node_modules/electron/path.txt` missing**
  (`electron --version` throws "Electron failed to install correctly"). Fix:
  `node node_modules/electron/install.js`, then verify `./node_modules/.bin/electron --version`.

### Full install (copy-paste)
```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd ~/developer
gh repo clone aakashnarukula-dev/claude-fleet
cd claude-fleet
npm install
[ -f node_modules/electron/path.txt ] || node node_modules/electron/install.js  # finish electron postinstall if skipped
npm run rebuild                              # rebuild node-pty for Electron's ABI (required once)
./node_modules/.bin/electron --version       # sanity: should print v33.x

# --- build a real /Applications app ---
npm run dist                                 # → dist/mac-arm64/Claude Fleet.app  (unsigned)
codesign --force --deep --sign - "dist/mac-arm64/Claude Fleet.app"   # ad-hoc sign
cp -R "dist/mac-arm64/Claude Fleet.app" /Applications/

# --- make the icon render + register the app ---
touch "/Applications/Claude Fleet.app"
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "/Applications/Claude Fleet.app"
killall Finder Dock 2>/dev/null || true
```
First launch: right-click → **Open** (ad-hoc signed → one Gatekeeper prompt). If the
`/Applications` icon looks blank, that's a stale Finder icon cache — the `lsregister` +
`killall Finder Dock` above fixes it (a logout/login clears it fully). The icon file is
already embedded in the bundle (`Contents/Resources/icon.icns`).

> Note: the packaged app is what the user double-clicks. `npm run dist` under Node 22 also
> re-runs the node-pty rebuild against Electron's ABI, so a stale/blocked `npm run rebuild`
> won't leave the bundle broken. `.app` install location is `/Applications` (system) or
> `~/Applications` — this repo's `--rebuild` reinstall path checks `~/Applications` then
> `/Applications`; match wherever the user's existing copy lives.

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
  at runtime; don't import xterm via require in renderer. Also `src/vendor/caveman/`
  — the vendored caveman Claude Code plugin (see caveman auto-install below).
- `src/caveman-install.js` — standalone CommonJS module (no `electron` require;
  unit-testable). Exports `ensureCaveman({ vendorDir, homeDir })`: a one-time OFFLINE
  install of the vendored caveman plugin into the user's global `~/.claude`.
- `build/icon.icns` — app icon.

### Three modes (`config.html`)
A "Mode" segmented control picks **Single project** vs **Gyftalala — multi-repo**. Under Single
project the "Use orchestrator" checkbox still toggles Dispatch vs Grid.
- **Dispatch** (`mode:'dispatch'`, default, agentic): starts SOLO with one orchestrator
  pane; the orchestrator spawns its own workers on the fly (`--orchestrator`).
- **Grid** (`mode:'grid'`, "Use orchestrator" unchecked): a fixed set of N named worker
  panes you task directly; each owns its area and pushes itself (`--grid-plan`, `--grid-add`).
- **Gyftalala** (`mode:'gyftalala'`, multi-repo, always orchestrated/autonomous): one
  super-orchestrator coordinates ONE task across SEVERAL interconnected repos. The config
  shows a multi-select repo checklist (the 4 Gyftalala repos — `gyftalala/gyftalala`,
  `-server`, `-admin`, `splashbook-editor` — pre-checked, editable). It reuses the single-repo
  engine once per repo, with ONE shared coordination `.status` (the watcher surface) + per-repo
  fleet dirs, repo-tagged workers, and an atomic push across the whole set. See the Gyftalala
  multi-repo section below.

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
  `--clean`, `--gc`. `--spawn[-file]`/`--handoff` take an optional `--repo <name>` (multi-repo,
  see below); `--ship-all` is the multi-repo atomic push gate. Worker-side (run inside a
  worktree): `--done`, `--failed`, `--need`, `--unneed`, `--status`, `--statuses`.
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
- **Gyftalala multi-repo mode (added 2026-06-24):** one super-orchestrator coordinates ONE task
  across SEVERAL repos. The engine is REUSED verbatim once per repo, namespaced by session id.
  Env: `CLAUDE_FLEET_MULTI=1`, `CLAUDE_FLEET_REPOS` (colon-sep repo paths), `CLAUDE_FLEET_STATUS_DIR`
  (the ONE shared coordination `.status`, independent of any repo's `FLEET`). Layout: a coordination
  dir `<...>/Fleet-Sessions/gyftalala-multi-fleet-<sid>/` (only `.status` — the watcher surface) +
  per-repo fleet dirs `<repo>-fleet-<sid>/` (each with its own `_main` + workers on `fleet/s<sid>/<slug>`).
  Workers are repo-tagged: `--spawn[-file] H TASK --repo <name>` cuts the worktree from that repo's
  `_main` and writes a `"repo"` field into the `.spawn` marker (+ a `<slug>.repo` sidecar); the watcher
  spawns the pane with `CLAUDE_FLEET_REPO`=that repo. All panes share `CLAUDE_FLEET_STATUS_DIR`
  (coordination), so worker self-signals (`--done`/`--need`) land on the one board while git ops target
  their own repo. The orchestrator integrates each repo's workers into that repo's `_main`, then
  **`--ship-all`** = the HOLD-ALL atomic gate: dry-run every repo's merge to origin/main (ff-only,
  per-repo `gh_align`), push ALL or NONE. **GC:** the multi `cmd_orchestrator` writes each member
  fleet's `.status/repo` marker (reaped by the normal G0–G4 `gc_one_session`) + a coord `.status/members`
  marker; `gc_one_coord` reaps the coord only when non-live + not-self + ALL members gone (fail-safe-holds
  on an empty/partial marker). `--gc-all` routes `members`-flagged dirs to it. See [[gyftalala-multi-repo-mode]].

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
- **Caveman auto-install (added 2026-07-16):** on launch (`app.whenReady`, right after
  `buildMenu()`, before the `CFLEET_TEST` branch so it runs on EVERY launch) the app fires
  `ensureCaveman({ vendorDir })` (`src/caveman-install.js`) in a `setImmediate` + try/catch —
  fire-and-forget, non-blocking, can never delay window creation or throw into startup. It does a
  ONE-TIME OFFLINE install of the VENDORED caveman plugin (`src/vendor/caveman/`, pinned to
  JuliusBrussee/caveman **v1.9.1** / commit `033f918`, MIT, security-audited before vendoring — NO
  network, NO remote fetch): copies the hooks+skill into `~/.claude/caveman-fleet/` and the slash
  commands into `~/.claude/commands/`, then idempotently wires a `SessionStart`
  (`caveman-activate.js`) + `UserPromptSubmit` (`caveman-mode-tracker.js`) hook into
  `~/.claude/settings.json` (via the vendored `lib/settings.js` JSONC-tolerant merge). Effect: every
  `claude` PTY the app spawns inherits caveman mode by default (~65% fewer output tokens; code/
  commands/errors kept verbatim). Guards: marker `~/.claude/.caveman-fleet-installed` (skip if
  present — the fast every-launch-after path); also SKIPS wiring if a caveman `SessionStart` hook is
  already present (user installed it themselves → no double-firing). **Force a reinstall:** delete the
  marker. **Update caveman:** bump the tag, re-vendor the same file set, re-audit + re-run the sandbox
  test — see `src/vendor/caveman/VENDOR.md`. **Packaging:** `src/vendor/caveman/**` is in
  `build.asarUnpack` (the runtime copy needs real on-disk files, not asar entries); `main.js` swaps
  `app.asar`→`app.asar.unpacked` in `vendorDir` when packaged. Verify WITHOUT launching the app:
  `node --check` + the offline sandbox test (call `ensureCaveman` against a temp `homeDir`, assert
  files/hooks/marker + idempotent second run + `caveman-activate.js` emits `CAVEMAN MODE ACTIVE`).
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
