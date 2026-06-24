# Gyftalala Mode — multi-repo orchestration

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation
**Scope:** Add a new launch mode to Claude Fleet that orchestrates one task across multiple interconnected repos, with per-repo branching/merging/conflict-handling and an atomic push-to-main across the whole set.

## Problem

Claude Fleet today is single-repo: the engine (`bin/claude-fleet`) keys everything on one
`REPO` — the fleet dir, branch prefix `fleet/s<sid>/<slug>`, the detached `_main`
integration checkout, and the origin push are all per-repo. The config UI picks exactly
one repo.

The Gyftalala ecosystem is four interconnected repos under one brand:

| Brand name | Repo slug | Default branch |
|---|---|---|
| Gyftalala Frontend | `gyftalala/gyftalala` | `main` |
| Gyftalala Server | `gyftalala/gyftalala-server` | `main` |
| Gyftalala Admin | `gyftalala/gyftalala-admin` | `main` |
| Splashbook Editor | `gyftalala/splashbook-editor` | `main` |

A single feature/task routinely spans all four (a server endpoint + the frontend that
calls it + the admin surface + the editor). Today that needs four separate sessions with
no coordination. Gyftalala Mode runs one orchestrated task across the whole set, lands
proper branches in each repo, and ships them together.

## Approved decisions

1. **Topology:** one multi-repo orchestrator. A single super-orchestrator holds all
   selected repos, spawns each worker into whichever repo its sub-task touches, tracks
   cross-repo dependencies, and integrates + ships every repo.
2. **Push model:** direct push to `origin/main` per repo (these repos have origin
   remotes). No PR flow in v1.
3. **Partial failure:** atomic — hold all. Nothing is pushed until every repo's slice is
   integrated and verified. If one repo can't finish, the others are held back (branches
   remain, nothing reaches any `main`) and the blocker is reported.
4. **Repo configuration:** pick the set each launch. A multi-select repo picker, with the
   four Gyftalala repos pre-checked, editable per launch. "Gyftalala Mode" is really a
   general multi-repo mode whose default selection is the brand's four repos.

## Architecture

The guiding principle: **reuse the existing per-repo engine verbatim, once per repo**, and
add a thin multi-repo coordination layer above it. All branch/merge/conflict/advance-
canonical logic is unchanged; it is simply invoked per-repo, namespaced by session id.

### Session & worktree layout

```
~/Developer/<repo>/                       # each selected repo, cloned/fetched via gh as today
~/Developer/Fleet-Sessions/
  gyftalala-multi-fleet-<sid>/
    .status/                              # ONE shared coordination dir for the session
                                          #   (.spawn / .task / needs / manifest / statuses)
  gyftalala-fleet-<sid>/                  # per-repo fleet: _main + workers on fleet/s<sid>/<slug>
  gyftalala-server-fleet-<sid>/           # unchanged single-repo machinery, namespaced by sid
  gyftalala-admin-fleet-<sid>/
  splashbook-editor-fleet-<sid>/
```

- Each member repo gets its own `<basename>-fleet-<sid>` dir exactly as a single-repo
  session does today: its own `_main` detached integration checkout, its own worker
  worktrees on `fleet/s<sid>/<slug>`, its own origin push path.
- The multi-repo session adds **one** coordination dir, `gyftalala-multi-fleet-<sid>/`,
  whose `.status` is the single coordination surface the main-process watcher observes.
- The super-orchestrator pane runs with cwd in the coordination dir and can read any of
  the four cloned repos directly (read-only) to plan.

### UI (config.html)

- Add a mode selector to the second card: `Single project` (the existing flow) vs
  `Gyftalala — multi-repo`.
- Selecting Gyftalala:
  - Replaces the single-repo picker with a **multi-select checklist** of the connected
    `gyftalala` account's repos, the four ecosystem repos pre-checked, any addable/
    removable.
  - Forces orchestrator + autonomous on; hides the Grid (named-pane) toggle — multi-repo
    is always orchestrated.
  - "Launch fleet" emits a `mode:'gyftalala'` payload: `{ mode:'gyftalala', account,
    repos:[{nameWithOwner, defaultBranch}], autonomous:true, orchestrator:true }`.

### Launch path (main.js)

- `buildFleet` learns a `mode:'gyftalala'` branch. It:
  - Clones/fetches each selected repo to `~/Developer/<name>` (reuse `ensureRepoClone`
    in a loop).
  - Reserves one `sid`; creates the coordination dir + per-repo fleet dirs.
  - Records a multi-repo session: `s.mode = 'gyftalala'`, `s.repos = [...]`,
    `s.coordDir`, `s.statusDir = coordDir/.status`.
  - Spawns the super-orchestrator pane (cwd = coordination dir; env carries the repo set).
- `startWatcher` watches the coordination `.status`. `handleSpawn` reads a new `repo`
  field on the `.spawn` marker, resolves that repo's fleet worktree dir, and spawns the
  worker pane there (the pane's cwd is the worker worktree inside that repo's fleet).
- State persistence (`saveState`/`restoreSessions`) records the repo set so a multi-repo
  session restores correctly.

### Engine (bin/claude-fleet)

- **Repo-tagged spawning.** Add `--repo <slug>` to `--spawn` / `--spawn-file` / `--handoff`.
  When present, the CLI resolves that repo's `REPO` path + fleet dir and creates the
  worker worktree/branch there, writing the target repo into the `.spawn` marker so the
  watcher spawns the pane in the right place. Without `--repo`, behavior is unchanged
  (single-repo sessions unaffected).
- **Repo-aware coordination.** `--need` / `--handoff` / `--statuses` operate against the
  shared coordination `.status`, tagging entries with their repo so the orchestrator can
  schedule cross-repo work. Cross-repo dependency is sequencing + brief-passing (the
  orchestrator integrates the producing repo's slice, then hands the consuming worker the
  contract in its brief) — there are no cross-repo git merges.
- **Atomic ship.** New subcommand `--ship-all` (super-orchestrator), the hold-all gate:
  1. For each member repo: confirm every worker integrated into that repo's `_main`; run
     the repo's verification command if configured.
  2. **Dry-run** the integration → `origin/main` for each repo: `git fetch origin`, then
     confirm a clean fast-forward / conflict-free merge of the integrated `_main` HEAD
     onto `origin/main`.
  3. If **every** repo passes both gates → push all repos to `origin/main`.
  4. If **any** repo fails either gate → push **none**; leave all branches intact; print
     the blocking repo(s) and the reason. Exit non-zero so the orchestrator reports and
     does not falsely claim "shipped."
- The super-orchestrator prompt is a new multi-repo variant: it knows it holds N repos,
  spawns with `--repo`, sequences cross-repo dependencies, and finishes with `--ship-all`.

### Autonomy / allowlist (main.js)

- The super-orchestrator pane keeps the orchestrator allowlist (it may push). Workers in
  each repo use the standard worker allowlist. `git push` to origin is permitted only at
  the `--ship-all` gate (and per the existing per-repo orchestrator rules), preserving the
  "only the lead ships" invariant — extended across repos.

## What is reused vs new

**Reused unchanged:** per-repo worktrees, branch prefixes, `_main` integration,
`advance_canonical_branch`, intra-repo conflict handling, `--done/--failed/--need/
--merged/--ready/--next`, gh-align, gc/`--gc-all`.

**New:** multi-repo session bookkeeping in main.js; `mode:'gyftalala'` config UI + launch +
multi-repo clone; `--repo`-tagged spawn/handoff/need in the engine; the coordination
`.status` watcher wiring for repo-tagged spawns; `--ship-all` atomic gate; the multi-repo
super-orchestrator prompt.

## Non-goals (v1)

- No cross-repo git submodule / monorepo merging.
- No PR flow — direct push to `main`, per the approved push model.
- No automatic cross-repo schema/contract verification beyond what the orchestrator
  arranges via sequencing and per-repo verification commands.
- The repo set defaults to the four Gyftalala repos but is not hardcoded; any repo on the
  connected account can be added or removed at launch.

## Risks / open points

- **Atomicity is best-effort, not transactional.** `--ship-all` dry-runs every repo before
  pushing any, which catches the common conflicts, but four separate `git push`es are not
  a single atomic transaction — a push can still fail after an earlier one succeeded
  (e.g. someone pushed to one repo between dry-run and push). Mitigation: push in a fixed
  order, fetch + re-confirm fast-forward immediately before each push, and on a mid-sequence
  failure stop and report exactly which repos already landed so the state is recoverable.
- **Pane count.** N repos × workers can produce many panes; the grid must stay legible.
  The orchestrator should keep concurrent workers modest.
- **Account scope.** The multi-select lists one connected account's repos; a cross-account
  ecosystem is out of scope for v1.
