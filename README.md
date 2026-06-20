<div align="center">

# 🛰️ Claude Fleet

**Run a whole fleet of [Claude Code](https://claude.com/claude-code) agents in parallel — each in its own git worktree — from one desktop app.**

Pick a project, give one goal. An orchestrator splits it across worker terminals, each works an isolated worktree, then it integrates and ships.

[![Platform](https://img.shields.io/badge/platform-macOS-black)](#requirements)
[![Electron](https://img.shields.io/badge/built%20with-Electron-47848F)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

## What it is

Claude Fleet is a **terminal-grid desktop app** for orchestrating many Claude Code sessions at once. Instead of babysitting one agent in one terminal, you launch a *fleet*: a grid of `claude` PTYs, each pinned to its own **git worktree** so they never step on each other, coordinated through a small file-based protocol.

```
                      ┌──────────────────────────────────────────┐
                      │              Claude Fleet (UI)            │
                      │   tabs · xterm grid · permission overlay  │
                      └───────────────┬──────────────────────────┘
                                      │ spawns + watches
                ┌─────────────────────┼─────────────────────┐
                ▼                     ▼                     ▼
        ┌──────────────┐     ┌──────────────┐      ┌──────────────┐
        │ orchestrator │ ──▶ │  worker A    │      │  worker B    │
        │   (_main)    │     │  <repo>-     │      │  <repo>-     │
        │              │     │  fleet-N/A   │      │  fleet-N/B   │
        └──────┬───────┘     └──────┬───────┘      └──────┬───────┘
               │ integrates         │ commits             │ commits
               ▼                    ▼                     ▼
        ┌────────────────────────────────────────────────────────┐
        │   one git repo · isolated worktrees · branches merged    │
        └────────────────────────────────────────────────────────┘
```

## Why

One Claude Code agent is great. Five working in parallel on independent slices of the same goal — with automatic worktree isolation, integration, and cleanup — is a different gear. Claude Fleet handles the plumbing: worktrees, branches, the orchestrator↔worker handoff protocol, autonomous-but-scoped permissions, and tearing it all down when the work lands.

## Features

- 🧠 **Two modes.** *Dispatch* — one orchestrator splits your goal and spawns its own workers on the fly. *Grid* — you open N named worker panes and task each directly; every pane owns its area and pushes itself.
- 🌳 **True isolation.** Each worker runs in its own `git worktree` (`<repo>-fleet-<sid>/<slug>`), so parallel edits never collide.
- 🔀 **Integrate & ship.** The orchestrator merges worker branches and advances the canonical branch; with a GitHub remote it pushes, locally it fast-forwards.
- 🧹 **Self-cleaning.** Finished, fully-merged sessions are garbage-collected automatically (guarded so a live or unmerged session is never touched).
- 🔐 **Multi-account GitHub.** Connect/disconnect any number of GitHub accounts (via the `gh` CLI), browse each account's repos — public and private — and clone + launch in one click.
- ⚡ **Autonomous, but scoped.** Opt-in auto-approve for safe verbs (edits, `git add/commit/merge`, push to the project branch); `rm`, `curl`, `sudo` and friends still prompt.
- 🖥️ **Real terminals.** Full `xterm.js` grid with tab tear-off, an always-on-top permission overlay, and a built-in file browser/editor (Monaco).

## Requirements

| Tool | Why | Install |
|------|-----|---------|
| **macOS** (Apple Silicon or Intel) | the app targets darwin | — |
| **[Claude Code](https://claude.com/claude-code)** (`claude` on `PATH`) | the agent each pane runs | `npm i -g @anthropic-ai/claude-code` |
| **[GitHub CLI](https://cli.github.com)** (`gh`) | connect accounts, list/clone repos | `brew install gh` |
| **git** | worktrees + integration | `brew install git` |
| **Node.js ≥ 18** + npm | build & run the app | `brew install node` |

> The fleet engine (`bin/claude-fleet`) ships **inside this repo** — no separate install.

## Quick start

```bash
git clone https://github.com/aakashnarukula-dev/claude-fleet.git
cd claude-fleet
npm install
npm run rebuild     # rebuild node-pty for Electron's ABI (required once after install)
npm start
```

Then in the window:

1. **Pick a project** — a local folder, or connect a GitHub account and choose a repo.
2. Leave **Use orchestrator** on for Dispatch mode, or turn it off to open named worker panes.
3. Hit **Launch fleet** and give your goal.

## Connecting GitHub accounts

Click **+ Connect account** in the launcher. A one-time device code appears; a browser opens to `github.com/login/device` — enter the code and authorize. The account shows up as a chip; click it to browse its repos, or the **✕** to disconnect.

Auth is handled entirely by the `gh` CLI (`gh auth login/logout`), so Claude Fleet never stores your tokens. Repo listing and cloning use each account's own credentials **without changing your globally-active `gh` account**.

## How it works

- **`src/main.js`** — Electron main process: windows, PTYs, IPC, the per-session status-dir watcher, GitHub/gh integration, and session persistence.
- **`src/config.html`** — the launcher: project/account picker, mode toggle, autonomy.
- **`src/grid.html`** — the tabbed xterm grid, drag-to-tear-off tabs, file panel.
- **`src/preload.js`** — the locked-down `contextBridge` IPC surface (`window.fleet`).
- **`bin/claude-fleet`** — the bash **engine** the app shells out to. It owns the worktree lifecycle: `--orchestrator`, `--grid-plan`, `--spawn`, `--handoff`, `--next`, `--merged`, `--gc`, `--clean`, and more. Worktrees live beside the repo at `<repo>-fleet-<session>/`; the orchestrator integrates into a detached `_main` checkout.

Coordination is file-based: workers drop `.done` / `.need` markers in a status dir; the watcher and the orchestrator react. Simple, observable, and crash-safe.

## Build a standalone app

```bash
npm run dist          # → dist/mac-arm64/Claude Fleet.app  (unsigned)
# optional: ad-hoc sign so macOS notifications work, then move to /Applications
codesign --force --deep --sign - "dist/mac-arm64/Claude Fleet.app"
cp -R "dist/mac-arm64/Claude Fleet.app" ~/Applications/
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `CLAUDE_FLEET_REPO` | the launcher's selection | project repo for a session |
| `CLAUDE_FLEET_SESSION` | per-tab id | namespaces worktrees/branches/status |
| `CLAUDE_FLEET_NO_AUTOGC` | unset | set `1` to disable auto garbage-collection |
| `CFLEET_TEST` / `CFLEET_AUTON` | unset | headless smoke-test hooks |

## License

[MIT](LICENSE) © aakashnarukula-dev
