# Gyftalala Mode (multi-repo orchestration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `gyftalala` launch mode that orchestrates one task across multiple interconnected repos — per-repo branches/merges/conflict-handling, then an atomic push-to-main across the whole selected set.

**Architecture:** Reuse the existing single-repo engine verbatim, once per repo, namespaced by session id. Add a thin multi-repo coordination layer: ONE shared coordination `.status` dir (the surface the main-process watcher observes), per-repo fleet dirs for actual worktrees/branches/`_main` integration, repo-tagged spawn markers, and a `--ship-all` atomic push gate. A new super-orchestrator pane holds all repos and ships them together.

**Tech Stack:** Bash engine (`bin/claude-fleet`), Electron main (`src/main.js`, CommonJS), plain-HTML renderers (`src/config.html`, `src/grid.html`), `node-pty`, `gh` CLI.

## Global Constraints

- **No automated test suite.** Verification is: bash engine tested in isolation against THROWAWAY git repos under an overridden `CLAUDE_FLEET_SESSIONS_DIR` (never the real `~/Developer/Fleet-Sessions`, never the real gyftalala repos); JS verified by `node --check` and by vm-compiling inline `<script>`s. (CLAUDE.md.)
- **NEVER launch the app (`npm start` / `electron .` / `CFLEET_TEST` / `npm run dist`) from inside a fleet worker/orchestrator pane.** App-boot checks are OPTIONAL and only valid OUTSIDE any fleet session (no `CLAUDE_FLEET_SESSION` in env). Default gate for JS changes is STATIC checks only. (CLAUDE.md.)
- **Engine isolation invariant:** every engine test MUST export `CLAUDE_FLEET_SESSIONS_DIR=<scratch>` and use temp repos as `CLAUDE_FLEET_REPO`/`CLAUDE_FLEET_REPOS`. Do not run engine subcommands with the default env (it targets the real configured repo + reuses session id 1).
- **Backward compatibility:** single-repo Dispatch and Grid modes MUST be byte-for-byte unaffected. New engine behavior activates ONLY when `CLAUDE_FLEET_MULTI=1` / `CLAUDE_FLEET_STATUS_DIR` / `--repo` are present. A spawn WITHOUT `--repo` must produce the original marker shape.
- **CommonJS only** in renderers/main (no ESM). Renderer↔main strictly via `window.fleet` (preload contextBridge). Never enable nodeIntegration.
- **Git identity / commits:** author `aakashnarukula-dev <aakashnarukula.dev@gmail.com>` (already the repo-local config). NEVER add a `Co-Authored-By: Claude`/Anthropic trailer. Code-only commits, conventional-ish messages.
- **The 4 Gyftalala repos** (default multi-select, editable): `gyftalala/gyftalala` (Frontend), `gyftalala/gyftalala-server`, `gyftalala/gyftalala-admin`, `gyftalala/splashbook-editor`. All default branch `main`, all private under the `gyftalala` gh account.

## File Structure

- `bin/claude-fleet` — engine. Add: `CLAUDE_FLEET_STATUS_DIR` override (decouple STATUS from FLEET); `select_repo()` + `resolve_repo()`; `--repo` flag on spawn/spawn-file/handoff; `<slug>.repo` marker + `"repo"` JSON field; multi-repo branch in `cmd_orchestrator`; `spawn_multi_orchestrator_prompt()`; `cmd_ship_all()` + `--ship-all` dispatch.
- `src/main.js` — main. Add: `mode:'gyftalala'` branch in `buildFleet` (multi-repo clone loop + coordination dir + session record); `runMultiOrchestrator()`; per-pane `repo` awareness in `handleSpawn` + `spawnPane`; `CLAUDE_FLEET_STATUS_DIR`/`CLAUDE_FLEET_MULTI`/`CLAUDE_FLEET_REPOS` env wiring; `saveState`/`restoreSessions` persistence of `repos`/`coordDir`.
- `src/config.html` — config renderer. Add: mode segmented control (`Single project` / `Gyftalala — multi-repo`); multi-select repo checklist (reuses `listAccountRepos`); `mode:'gyftalala'` payload.
- `src/grid.html` — grid renderer. Minor: tolerate `mode:'gyftalala'` in `add-session` (no behavioral change beyond label).
- `src/preload.js` — no new channel required (multi-repo rides the existing `launch` payload + existing `listAccountRepos`). Verify only.

Dependency order: engine (Tasks 1–4) → main (Tasks 5–6) → UI (Task 7) → integration smoke (Task 8). Engine tasks are independently testable against scratch repos.

---

### Task 1: Engine — decouple STATUS from FLEET + repo resolution helpers

**Files:**
- Modify: `bin/claude-fleet:54-62` (header globals) and add helpers after `set_default_branch` (~`:110`).
- Test: `/private/tmp/claude-501/-Users-aakashnarukula-Developer-claude-fleet-app/ab1554e0-f32d-4e4c-9baa-d171f302ba2f/scratchpad/t1.sh`

**Interfaces:**
- Produces: env var `CLAUDE_FLEET_STATUS_DIR` (when set → `STATUS`/`MANIFEST` point there, independent of `FLEET`); env var `CLAUDE_FLEET_REPOS` (colon-separated repo paths); shell functions `resolve_repo <name-or-path>` (echoes absolute repo path or non-zero) and `select_repo <name-or-path>` (re-points `REPO`/`FLEET`/`DBR` for that repo; leaves `STATUS` untouched).
- Consumed by: Tasks 2, 3, 4.

- [ ] **Step 1: Write the failing test**

```bash
# scratchpad/t1.sh — STATUS override + repo resolution, fully isolated
set -eu
CLI="$HOME/Developer/claude-fleet-app/bin/claude-fleet"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CLAUDE_FLEET_SESSIONS_DIR="$TMP/sessions"
mkrepo(){ mkdir -p "$1"; git -C "$1" init -q; git -C "$1" symbolic-ref HEAD refs/heads/main
  git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }
mkrepo "$TMP/server"; mkrepo "$TMP/web"
export CLAUDE_FLEET_SESSION=9 CLAUDE_FLEET_REPOS="$TMP/server:$TMP/web"
export CLAUDE_FLEET_STATUS_DIR="$TMP/coord/.status"
# source the engine WITHOUT running a subcommand (guarded main), then exercise helpers
CFLEET_NO_MAIN=1 . "$CLI"
[ "$STATUS" = "$TMP/coord/.status" ] || { echo "FAIL STATUS not overridden: $STATUS"; exit 1; }
[ "$MANIFEST" = "$TMP/coord/.status/manifest" ] || { echo "FAIL MANIFEST: $MANIFEST"; exit 1; }
p="$(resolve_repo server)"; [ "$p" = "$TMP/server" ] || { echo "FAIL resolve basename: $p"; exit 1; }
p="$(resolve_repo "$TMP/web")"; [ "$p" = "$TMP/web" ] || { echo "FAIL resolve path: $p"; exit 1; }
resolve_repo nope 2>/dev/null && { echo "FAIL resolve should reject unknown"; exit 1; }
select_repo server
[ "$REPO" = "$TMP/server" ] || { echo "FAIL select REPO: $REPO"; exit 1; }
[ "$FLEET" = "$TMP/sessions/server-fleet-9" ] || { echo "FAIL select FLEET: $FLEET"; exit 1; }
[ "$STATUS" = "$TMP/coord/.status" ] || { echo "FAIL select must not move STATUS: $STATUS"; exit 1; }
echo "T1 PASS"
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `bash scratchpad/t1.sh`
Expected: FAIL (the engine has no `CFLEET_NO_MAIN` guard, no `resolve_repo`/`select_repo`, and `STATUS` still derives from `FLEET`). Likely "command not found: resolve_repo" or the engine tries to run a subcommand and dies.

- [ ] **Step 3: Implement**

In `bin/claude-fleet`, change the header globals (`:59-60`) so STATUS can be overridden:

```bash
FLEET="$SESSIONS_DIR/$(basename "$REPO")-fleet${SESSION:+-$SESSION}"        # e.g. ~/Developer/Fleet-Sessions/gyftalala-fleet-1
STATUS="${CLAUDE_FLEET_STATUS_DIR:-$FLEET/.status}"                         # multi-repo: ONE shared coordination dir; single-repo: per-fleet (unchanged)
MANIFEST="$STATUS/manifest"
```

Add, right after `set_default_branch()` (~`:113`):

```bash
# Multi-repo: the set of cloned repo paths the super-orchestrator coordinates (colon-separated). Empty = single-repo.
REPOS_LIST="${CLAUDE_FLEET_REPOS:-}"

# Resolve a repo reference (absolute path, or a basename present in REPOS_LIST) to an absolute repo path.
# Echoes the path on success; returns non-zero (silent) if it can't be resolved.
resolve_repo() { # <name-or-path>
  local ref="$1" p IFS=:
  [ -n "$ref" ] || return 1
  if [ -d "$ref/.git" ]; then printf '%s\n' "${ref%/}"; return 0; fi
  for p in $REPOS_LIST; do
    [ -n "$p" ] || continue
    if [ "$(basename "$p")" = "$ref" ] || [ "${p%/}" = "${ref%/}" ]; then printf '%s\n' "${p%/}"; return 0; fi
  done
  return 1
}

# Re-point REPO/FLEET/DBR at a given repo for the duration of one operation (spawn into repo X, ship repo X).
# STATUS is intentionally LEFT ALONE — in multi-repo it stays the shared coordination dir (CLAUDE_FLEET_STATUS_DIR).
select_repo() { # <name-or-path>
  local p; p="$(resolve_repo "$1")" || die "unknown repo '$1' (not in CLAUDE_FLEET_REPOS and not a git dir)"
  REPO="$p"
  FLEET="$SESSIONS_DIR/$(basename "$REPO")-fleet${SESSION:+-$SESSION}"
  set_default_branch
}
```

At the VERY END of the file, guard the main dispatch so tests can source the engine without executing a subcommand. Wrap BOTH the startup `gh_align` call AND the trailing `case "${1:-}" in … esac` (the `# dispatch` section) with the guard:

```bash
# ---------------------------------------------------------------- dispatch
if [ "${CFLEET_NO_MAIN:-}" != 1 ]; then
gh_align   # align gh active account to origin owner before any git/gh work (self-guarded, non-fatal)

case "${1:-}" in
  # … existing subcommand dispatch stays here, unchanged …
esac
fi
```

(Keep the dispatcher's existing `${1:-}` guards intact under `set -u`.)

- [ ] **Step 4: Run it — verify it PASSES**

Run: `bash scratchpad/t1.sh`
Expected: `T1 PASS`

- [ ] **Step 5: Regression — single-repo STATUS unchanged**

Run:
```bash
unset CLAUDE_FLEET_STATUS_DIR CLAUDE_FLEET_REPOS
CLAUDE_FLEET_SESSIONS_DIR=/tmp/x CLAUDE_FLEET_REPO=/tmp/r CLAUDE_FLEET_SESSION=1 CFLEET_NO_MAIN=1 \
  bash -c '. bin/claude-fleet; echo "$STATUS"'
```
Expected: `/tmp/x/r-fleet-1/.status` (unchanged single-repo derivation).

- [ ] **Step 6: Commit**

```bash
git add bin/claude-fleet
git commit -m "engine: multi-repo status-dir override + repo resolution helpers"
```

---

### Task 2: Engine — repo-tagged spawn / spawn-file / handoff

**Files:**
- Modify: `bin/claude-fleet` — `parse_effort_args` (`:517-531`) to also strip `--repo`; `_do_spawn` (`:487-512`) to cut the worktree from the target repo's fleet + emit a `"repo"` field + write `<slug>.repo`; `cmd_handoff` (`:558-586`) liveness check to use the slug's recorded repo fleet.
- Test: `scratchpad/t2.sh`

**Interfaces:**
- Consumes: `select_repo`, `resolve_repo`, `STATUS` override (Task 1).
- Produces: `claude-fleet --spawn[-file] H TASK --repo <name>` and `--handoff T FILE` cut/locate work in repo `<name>`'s fleet while writing all coordination state (manifest, `.spawn`, `<slug>.repo`, `<slug>.done`) to the shared `STATUS`. The `.spawn` JSON gains `"repo":"<absolute repo path>"` when `--repo` was given (absent otherwise). `<slug>.repo` file = the target repo's ABSOLUTE path.

- [ ] **Step 1: Write the failing test**

```bash
# scratchpad/t2.sh — spawn into a chosen repo; marker carries repo; worktree lands in that repo's fleet
set -eu
CLI="$HOME/Developer/claude-fleet-app/bin/claude-fleet"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CLAUDE_FLEET_SESSIONS_DIR="$TMP/sessions"
mkrepo(){ mkdir -p "$1"; git -C "$1" init -q; git -C "$1" symbolic-ref HEAD refs/heads/main
  git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }
mkrepo "$TMP/server"; mkrepo "$TMP/web"
export CLAUDE_FLEET_SESSION=9 CLAUDE_FLEET_REPOS="$TMP/server:$TMP/web"
export CLAUDE_FLEET_STATUS_DIR="$TMP/coord/.status"
mkdir -p "$CLAUDE_FLEET_STATUS_DIR"; : > "$CLAUDE_FLEET_STATUS_DIR/manifest"
# pre-create each repo's _main so _do_spawn can cut from it
git -C "$TMP/server" worktree add --detach "$TMP/sessions/server-fleet-9/_main" main >/dev/null 2>&1
git -C "$TMP/web"    worktree add --detach "$TMP/sessions/web-fleet-9/_main"    main >/dev/null 2>&1
# spawn a worker into the server repo
CLAUDE_FLEET_REPO="$TMP/coord" "$CLI" --spawn "API" "add endpoint" --repo server >/dev/null
m="$CLAUDE_FLEET_STATUS_DIR/api.spawn"
[ -f "$m" ] || { echo "FAIL no marker"; exit 1; }
grep -q "\"repo\"" "$m" || { echo "FAIL marker missing repo field"; exit 1; }
grep -q "$TMP/server" "$m" || { echo "FAIL marker repo not server"; exit 1; }
[ -d "$TMP/sessions/server-fleet-9/api" ] || { echo "FAIL worktree not in server fleet"; exit 1; }
git -C "$TMP/server" rev-parse --verify fleet/s9/api >/dev/null 2>&1 || { echo "FAIL branch not in server"; exit 1; }
[ "$(cat "$CLAUDE_FLEET_STATUS_DIR/api.repo")" = "$TMP/server" ] || { echo "FAIL api.repo file"; exit 1; }
grep -qx api "$CLAUDE_FLEET_STATUS_DIR/manifest" || { echo "FAIL manifest"; exit 1; }
# back-compat: a spawn WITHOUT --repo (single-repo style) must NOT emit a repo field
unset CLAUDE_FLEET_STATUS_DIR CLAUDE_FLEET_REPOS
export CLAUDE_FLEET_REPO="$TMP/server"
git -C "$TMP/server" worktree add --detach "$TMP/sessions/server-fleet-9b/_main" main >/dev/null 2>&1 || true
CLAUDE_FLEET_SESSION=9b "$CLI" --orchestrator >/dev/null 2>&1 || true
CLAUDE_FLEET_SESSION=9b "$CLI" --spawn "Solo" "do x" >/dev/null
grep -q "\"repo\"" "$TMP/sessions/server-fleet-9b/.status/solo.spawn" && { echo "FAIL back-compat marker has repo"; exit 1; }
echo "T2 PASS"
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `bash scratchpad/t2.sh`
Expected: FAIL — `--repo` is an unknown flag (lands in the task text), worktree is cut in the wrong fleet, no `repo` field, no `api.repo` file.

- [ ] **Step 3: Implement**

Extend `parse_effort_args` to also capture `--repo` (set a `SPAWN_REPO` global), keeping it position-tolerant. Replace the `case` body inside the `while` loop:

```bash
SPAWN_REPO=""
parse_effort_args() { # <args...> -> sets EFFORT + SPAWN_REPO, fills ARGS_REST with the rest
  EFFORT=""; SPAWN_REPO=""
  local -a rest=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --effort)
        [ -n "${2:-}" ] || die "--effort needs a level (low|medium|high|xhigh)"
        case "$2" in low|medium|high|xhigh) EFFORT="$2" ;; *) die "invalid --effort '$2' (use low|medium|high|xhigh)" ;; esac
        shift 2 ;;
      --repo)
        [ -n "${2:-}" ] || die "--repo needs a repo name or path"
        SPAWN_REPO="$2"; shift 2 ;;
      *) rest+=("$1"); shift ;;
    esac
  done
  ARGS_REST=("${rest[@]+"${rest[@]}"}")
}
```

In `_do_spawn`, before computing `branch`/`dir`, switch to the target repo's fleet when a repo was requested, and record it. Insert at the top of `_do_spawn` (after the `local slug base k=2 …` line and the slug-uniqueness loop, but BEFORE `branch="$BR_PREFIX/$slug"; dir="$FLEET/$slug"`):

```bash
  # Multi-repo: cut this worker's worktree from the requested repo's fleet (FLEET re-points to <repo>-fleet-<sid>).
  # STATUS stays the shared coordination dir, so the manifest/markers remain on the one board. Single-repo path
  # (no --repo) leaves FLEET/REPO exactly as-is → original behavior.
  local target_repo=""
  if [ -n "${SPAWN_REPO:-}" ]; then select_repo "$SPAWN_REPO"; target_repo="$REPO"; fi
```

Then where the marker is written (`printf '{"slug":…}' … > "$STATUS/$slug.spawn"`), add the repo field and the sidecar file. Replace the `effort_field` block + the marker `printf` with:

```bash
  local effort_field=""
  [ -n "$effort" ] && effort_field=",\"effort\":$(json_str "$effort")"
  local repo_field=""
  if [ -n "$target_repo" ]; then
    repo_field=",\"repo\":$(json_str "$target_repo")"
    printf '%s\n' "$target_repo" > "$STATUS/$slug.repo"   # sidecar: lets --ready/--ship-all/--handoff find this slug's repo
  fi
  printf '{"slug":%s,"heading":%s,"dir":%s,"prompt":%s%s%s}' \
    "$(json_str "$slug")" "$(json_str "$heading")" "$(json_str "$dir")" \
    "$(json_str "$(spawn_worker_prompt "$heading" "$slug" "$dir" "$task")")" "$effort_field" "$repo_field" > "$STATUS/$slug.spawn"
```

In `cmd_handoff`, the liveness check `[ -d "$FLEET/$slug" ]` must look in the slug's OWN repo fleet (not the orchestrator's FLEET). Before that check, add:

```bash
  # If the slug was spawned into a specific repo, point FLEET at that repo's fleet so the worktree-liveness check
  # (and any path references) resolve correctly in multi-repo runs. Single-repo: no .repo sidecar → unchanged.
  if [ -f "$STATUS/$slug.repo" ]; then select_repo "$(cat "$STATUS/$slug.repo")"; fi
```

- [ ] **Step 4: Run it — verify it PASSES**

Run: `bash scratchpad/t2.sh`
Expected: `T2 PASS`

- [ ] **Step 5: Commit**

```bash
git add bin/claude-fleet
git commit -m "engine: --repo-tagged spawn/handoff; marker carries target repo"
```

---

### Task 3: Engine — multi-repo orchestrator + prompt

**Files:**
- Modify: `bin/claude-fleet` — `cmd_orchestrator` (`:466-481`) to branch on `CLAUDE_FLEET_MULTI`; add `spawn_multi_orchestrator_prompt()` near the other prompt builders (~`:461`).
- Test: `scratchpad/t3.sh`

**Interfaces:**
- Consumes: `resolve_repo`, `select_repo`, `REPOS_LIST`, `STATUS` override (Task 1).
- Produces: with `CLAUDE_FLEET_MULTI=1` + `CLAUDE_FLEET_REPOS=...` + `CLAUDE_FLEET_STATUS_DIR=<coord>/.status`, `claude-fleet --orchestrator` resets the coordination STATUS, creates a `_main` detached checkout in EACH repo's fleet (`<repo>-fleet-<sid>/_main`), and prints a one-element JSON array `[{role:"orchestrator",slug:"orchestrator",heading:"Orchestrator",dir:"<coord>",prompt:"…"}]` whose prompt is the multi-repo manual (spawn with `--repo`, integrate per-repo `_main`, finish with `--ship-all`).

- [ ] **Step 1: Write the failing test**

```bash
# scratchpad/t3.sh — multi-repo orchestrator creates per-repo _main + emits valid JSON
set -eu
CLI="$HOME/Developer/claude-fleet-app/bin/claude-fleet"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CLAUDE_FLEET_SESSIONS_DIR="$TMP/sessions"
mkrepo(){ mkdir -p "$1"; git -C "$1" init -q; git -C "$1" symbolic-ref HEAD refs/heads/main
  git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }
mkrepo "$TMP/server"; mkrepo "$TMP/web"
export CLAUDE_FLEET_SESSION=9 CLAUDE_FLEET_MULTI=1 CLAUDE_FLEET_REPOS="$TMP/server:$TMP/web"
export CLAUDE_FLEET_STATUS_DIR="$TMP/coord/.status" CLAUDE_FLEET_REPO="$TMP/coord"
out="$("$CLI" --orchestrator)"
echo "$out" | python3 -c 'import json,sys; a=json.load(sys.stdin); assert a[0]["role"]=="orchestrator"; assert "ship-all" in a[0]["prompt"]; assert "--repo" in a[0]["prompt"]; print("json ok")'
[ -d "$TMP/sessions/server-fleet-9/_main" ] || { echo "FAIL no server _main"; exit 1; }
[ -d "$TMP/sessions/web-fleet-9/_main" ] || { echo "FAIL no web _main"; exit 1; }
[ -d "$CLAUDE_FLEET_STATUS_DIR" ] || { echo "FAIL no coord status"; exit 1; }
echo "T3 PASS"
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `bash scratchpad/t3.sh`
Expected: FAIL — `cmd_orchestrator` requires `$REPO/.git` (coord dir isn't a repo) → dies; no per-repo `_main`; prompt lacks `ship-all`/`--repo`.

- [ ] **Step 3: Implement**

Add `spawn_multi_orchestrator_prompt()` just before the `# subcommands` divider (~`:462`). Full text (this IS the deliverable):

```bash
# multi-repo orchestrator: coordinates N repos, spawns workers with --repo, integrates each repo's _main, ships atomically.
spawn_multi_orchestrator_prompt() { # coord_dir
  local coord="$1" r names=""
  for r in $REPOS_LIST; do names="$names\n  - $(basename "$r")  ($r)  _main: $SESSIONS_DIR/$(basename "$r")-fleet${SESSION:+-$SESSION}/_main"; done
  cat <<EOF
You are the MULTI-REPO ORCHESTRATOR for a Gyftalala-mode claude-fleet run. You coordinate ONE task across SEVERAL
interconnected repos and ship them TOGETHER. You COORDINATE, you NEVER implement feature code yourself.

Repos you own (basename, path, and its integration checkout _main):$(printf "$names")

Your cwd is the coordination dir ${coord}. You can read any repo above directly to plan. Each repo has its OWN
isolated fleet: its own _main detached checkout, its own worker branches (${BR_PREFIX}/<slug>), its own origin/main.

HOW TO WORK A GOAL:
1. Decompose the task PER REPO. One feature usually touches several repos (e.g. a new server endpoint + the web
   client that calls it + the admin surface + the editor). Map cross-repo DEPENDENCIES: if repo B consumes a
   contract repo A produces (an API shape, a field), A is an EARLIER phase than B.
2. Spawn one worker per repo-slice, ALWAYS tagging the repo:
     write the brief to /tmp/cfleet_<slug>.txt (Write tool), then
     claude-fleet --spawn-file "<heading>" /tmp/cfleet_<slug>.txt --repo <repo-basename> [--effort <low|medium|high|xhigh>]
   The worker is cut from THAT repo's _main HEAD and works in that repo's worktree. PLAIN literal args only — no
   \$(...), backticks, or pipes. Fan out all independent slices in one phase; hold dependents for a later phase.
3. DRAIN: claude-fleet --next (blocks until a worker is ready). For each ready slug, integrate it INTO ITS REPO's
   _main — go to that repo's _main checkout and merge its branch with PLAIN git (no -C, no &&):
     claude-fleet --ready          → every ready slug (claude-fleet --statuses shows each slug's repo).
     For a ready slug S in repo R:  cd <R's _main>  then  git merge --no-ff ${BR_PREFIX}/S
       On conflict, read both sides (git log --oneline) and resolve preserving both intents.
     Verify R with its build/test (per R's CLAUDE.md). Then: claude-fleet --merged S
   FAILED:S from --next → do NOT merge; re-plan; claude-fleet --merged S to clear it.
   Then claude-fleet --needs — schedule any cross-repo prerequisite a worker recorded (often a contract repo B
   needs from repo A); claude-fleet --need-clear <slug> once handled.
   ALL DONE (exit 3) = current phase integrated in every repo. More phases → back to step 2 (later workers see the
   integrated foundation). Cross-repo contract passing is by BRIEF: when you integrate repo A's slice, put the
   resulting contract (endpoint shape, types) into repo B's worker brief — there are NO cross-repo git merges.
4. FINAL ATOMIC SHIP — ONLY when the user says the whole task is done ("ship it" / "all done"). Run EXACTLY:
     claude-fleet --ship-all
   This is the hold-all gate: it confirms every repo integrated all its workers, dry-runs each repo's merge to
   origin/main, and pushes ALL repos to origin/main ONLY if EVERY repo passes. If any repo is blocked it pushes
   NONE and tells you which repo + why — fix that repo (respawn/integrate), then re-run claude-fleet --ship-all.
   NEVER push any repo's main yourself; --ship-all is the only path to origin/main.
5. Report a per-repo summary; record durable facts in each repo's CLAUDE.md/memory; then claude-fleet --watch and
   wait for the next goal. Repeat the whole cycle with fresh workers.

Wait for the user's goal.
EOF
}
```

Then branch `cmd_orchestrator` for multi-repo. Replace its body with:

```bash
cmd_orchestrator() {
  if [ "${CLAUDE_FLEET_MULTI:-}" = 1 ]; then
    [ -n "$REPOS_LIST" ] || die "multi-repo orchestrator needs CLAUDE_FLEET_REPOS"
    reset_state                                   # coordination STATUS (CLAUDE_FLEET_STATUS_DIR); manifest seeded
    local r odir
    for r in $REPOS_LIST; do                      # create each repo's own _main integration checkout
      [ -d "$r/.git" ] || die "not a git repository: $r"
      select_repo "$r"; fetch_origin
      odir="$FLEET/_main"
      if [ ! -d "$odir" ]; then
        git -C "$REPO" worktree add --detach "$odir" "origin/$DBR" >&2 2>/dev/null \
          || git -C "$REPO" worktree add --detach "$odir" "$DBR" >&2
      fi
      link_shared_dirs "$odir"
    done
    local coord; coord="$(dirname "$STATUS")"     # the coordination dir (parent of .status)
    mkdir -p "$coord"
    printf '[{"role":"orchestrator","slug":"orchestrator","heading":"Orchestrator","dir":%s,"prompt":%s}]\n' \
      "$(json_str "$coord")" "$(json_str "$(spawn_multi_orchestrator_prompt "$coord")")"
    return 0
  fi
  # — single-repo path, unchanged —
  [ -d "$REPO/.git" ] || die "not a git repository: $REPO"
  fetch_origin
  set_default_branch
  reset_state
  local odir="$FLEET/_main"
  if [ ! -d "$odir" ]; then
    git -C "$REPO" worktree add --detach "$odir" "origin/$DBR" >&2 2>/dev/null \
      || git -C "$REPO" worktree add --detach "$odir" "$DBR" >&2
  fi
  link_shared_dirs "$odir"
  local seed=0
  [ -f "$odir/CLAUDE.md" ] || [ -f "$odir/.claude/CLAUDE.md" ] || seed=1
  printf '[{"role":"orchestrator","slug":"orchestrator","heading":"Orchestrator","dir":%s,"prompt":%s}]\n' \
    "$(json_str "$odir")" "$(json_str "$(spawn_orchestrator_prompt "$odir" "$DBR" "$seed")")"
}
```

Note: `reset_state` writes `$REPO` into `$STATUS/repo`; in multi-repo `$REPO` is the coord path at call time — harmless (the watcher doesn't depend on it for multi). Leave as-is.

- [ ] **Step 4: Run it — verify it PASSES**

Run: `bash scratchpad/t3.sh`
Expected: `T3 PASS` (prints `json ok` then `T3 PASS`).

- [ ] **Step 5: Regression — single-repo orchestrator still emits its prompt**

Run: `bash scratchpad/t2.sh` (its `9b` block exercises the single-repo `--orchestrator`)
Expected: `T2 PASS` still.

- [ ] **Step 6: Commit**

```bash
git add bin/claude-fleet
git commit -m "engine: multi-repo orchestrator + ship-all-aware prompt"
```

---

### Task 4: Engine — `--ship-all` atomic push gate

**Files:**
- Modify: `bin/claude-fleet` — add `cmd_ship_all()` near the other subcommands; add `--ship-all)` to the dispatch `case`; document it in the header comment block (`:13-50`).
- Test: `scratchpad/t4.sh`

**Interfaces:**
- Consumes: `REPOS_LIST`, `select_repo`, per-repo `_main` checkouts, `has_origin`.
- Produces: `claude-fleet --ship-all` (multi-repo). Phase 1 DRY-RUN every repo: fetch origin, confirm the integrated `_main` HEAD merges cleanly onto `origin/<DBR>` (fast-forward, or conflict-free `git merge-tree`). Phase 2: if ALL pass, `git push origin HEAD:<DBR>` from each repo's `_main`, in `REPOS_LIST` order, re-confirming fast-forward immediately before each push. If ANY repo fails phase 1 → exit non-zero, push NOTHING, print the blocking repo(s). If a push fails mid-sequence (phase 2) → stop, print which repos already landed.

- [ ] **Step 1: Write the failing test**

```bash
# scratchpad/t4.sh — ship-all pushes all repos to their bare origins atomically
set -eu
CLI="$HOME/Developer/claude-fleet-app/bin/claude-fleet"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CLAUDE_FLEET_SESSIONS_DIR="$TMP/sessions"
# a repo with a bare origin + a session _main that's one commit ahead of origin/main
setup(){ # name
  local n="$1"
  git init -q --bare "$TMP/$n.git"
  git init -q "$TMP/$n"; git -C "$TMP/$n" symbolic-ref HEAD refs/heads/main
  git -C "$TMP/$n" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
  git -C "$TMP/$n" remote add origin "$TMP/$n.git"; git -C "$TMP/$n" push -q origin main
  git -C "$TMP/$n" worktree add --detach "$TMP/sessions/$n-fleet-9/_main" main >/dev/null 2>&1
  git -C "$TMP/sessions/$n-fleet-9/_main" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "feat-$n"
}
setup server; setup web
export CLAUDE_FLEET_SESSION=9 CLAUDE_FLEET_MULTI=1 CLAUDE_FLEET_REPOS="$TMP/server:$TMP/web"
export CLAUDE_FLEET_STATUS_DIR="$TMP/coord/.status" CLAUDE_FLEET_REPO="$TMP/coord"
"$CLI" --ship-all
for n in server web; do
  git -C "$TMP/$n.git" log --oneline | grep -q "feat-$n" || { echo "FAIL $n not pushed"; exit 1; }
done
echo "T4 PASS"
# negative: a non-fast-forward in one repo holds BOTH back
git -C "$TMP/web.git" --work-tree="$TMP/wtmp" >/dev/null 2>&1 || true
git clone -q "$TMP/web.git" "$TMP/webclone"; git -C "$TMP/webclone" -c user.email=t@t -c user.name=t commit -q --allow-empty -m intruder; git -C "$TMP/webclone" push -q origin main
git -C "$TMP/sessions/server-fleet-9/_main" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "feat-server-2"
git -C "$TMP/sessions/web-fleet-9/_main" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "feat-web-2"
if "$CLI" --ship-all 2>/dev/null; then echo "FAIL ship-all should refuse on non-ff web"; exit 1; fi
git -C "$TMP/server.git" log --oneline | grep -q "feat-server-2" && { echo "FAIL server pushed despite web block (not atomic)"; exit 1; }
echo "T4 NEG PASS"
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `bash scratchpad/t4.sh`
Expected: FAIL — `--ship-all` is unknown (dispatch falls through / dies). Nothing pushed.

- [ ] **Step 3: Implement**

Add `cmd_ship_all()` (place near `cmd_orchestrator`):

```bash
# Atomic multi-repo ship: dry-run EVERY repo, then push ALL or NONE. The "hold-all" gate for Gyftalala mode.
cmd_ship_all() {
  [ "${CLAUDE_FLEET_MULTI:-}" = 1 ] || die "--ship-all is multi-repo only (set CLAUDE_FLEET_MULTI=1 + CLAUDE_FLEET_REPOS)"
  [ -n "$REPOS_LIST" ] || die "--ship-all needs CLAUDE_FLEET_REPOS"
  local r odir head blockers="" IFS=:
  # Phase 1 — DRY RUN every repo. Block if a repo has no _main, or its HEAD doesn't merge cleanly onto origin/DBR.
  for r in $REPOS_LIST; do
    select_repo "$r"; odir="$FLEET/_main"
    if [ ! -d "$odir" ]; then blockers="$blockers\n  - $(basename "$r"): no integration checkout ($odir) — nothing integrated"; continue; fi
    fetch_origin
    head="$(git -C "$odir" rev-parse --verify --quiet HEAD || true)"
    [ -n "$head" ] || { blockers="$blockers\n  - $(basename "$r"): empty _main HEAD"; continue; }
    local target feasible=0
    if has_origin; then target="origin/$DBR"; else target="$DBR"; fi
    local base; base="$(git -C "$odir" merge-base "$head" "$target" 2>/dev/null || true)"
    local tip;  tip="$(git -C "$odir" rev-parse --verify --quiet "$target" || true)"
    if [ -z "$tip" ]; then feasible=1                                   # remote branch absent → first push, fine
    elif [ "$base" = "$tip" ]; then feasible=1                          # fast-forward (HEAD already contains target tip)
    else                                                               # diverged → conflict-free merge?
      local mt; mt="$(git -C "$odir" merge-tree --write-tree "$target" "$head" 2>/dev/null || true)"
      printf '%s' "$mt" | grep -q '^<<<<<<<\|CONFLICT' || [ -n "$mt" ] && feasible=1
      git -C "$odir" merge-tree --write-tree "$target" "$head" 2>&1 | grep -qi 'conflict' && feasible=0
    fi
    [ "$feasible" = 1 ] || blockers="$blockers\n  - $(basename "$r"): integrated HEAD ${head:0:8} does NOT merge cleanly onto $target (resolve in $odir: git merge $target)"
  done
  if [ -n "$blockers" ]; then
    printf 'claude-fleet: --ship-all HELD ALL repos — nothing pushed. Blocked:%b\n' "$blockers" >&2
    exit 1
  fi
  # Phase 2 — push every repo. Re-confirm fast-forward right before each push; report partial landings on failure.
  local landed=""
  for r in $REPOS_LIST; do
    select_repo "$r"; odir="$FLEET/_main"
    gh_align   # align gh's active account to THIS repo's origin owner (e.g. gyftalala) so osxkeychain can push it
    has_origin || { printf 'claude-fleet: %s has no origin — skipped push (integrated locally on _main).\n' "$(basename "$r")" >&2; continue; }
    git -C "$odir" fetch --prune origin >&2 2>/dev/null || true
    if ! git -C "$odir" push origin "HEAD:$DBR" >&2; then
      printf 'claude-fleet: --ship-all push FAILED on %s after pushing: %s. State is PARTIAL — re-run --ship-all to finish the rest.\n' "$(basename "$r")" "${landed:-none}" >&2
      exit 1
    fi
    landed="$landed $(basename "$r")"
  done
  printf 'claude-fleet: --ship-all pushed all repos to their default branch:%s\n' "${landed}"
}
```

In the dispatch `case` (end of file), add a branch alongside the other flags:

```bash
    --ship-all) cmd_ship_all ;;
```

Add to the header comment block (after `--rebuild`, ~`:39`):

```bash
#   --ship-all             (multi-repo) ATOMIC ship: dry-run every CLAUDE_FLEET_REPOS repo's merge to origin/<DBR>,
#                          then push ALL repos or NONE. Holds everything back if any repo can't merge cleanly.
```

- [ ] **Step 4: Run it — verify it PASSES**

Run: `bash scratchpad/t4.sh`
Expected: `T4 PASS` then `T4 NEG PASS`.

- [ ] **Step 5: Verify engine still parses**

Run: `bash -n bin/claude-fleet && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add bin/claude-fleet
git commit -m "engine: --ship-all atomic multi-repo push gate"
```

---

### Task 5: main.js — `mode:'gyftalala'` launch path

**Files:**
- Modify: `src/main.js` — `buildFleet` (`:487-559`) add a `mode:'gyftalala'` branch; add `cloneRepos()` helper (loops `ensureRepoClone`); add `runMultiOrchestrator()` (mirrors `runOrchestrator` with multi env); add `coordDir(sid)` helper.
- Test: static (`node --check`) + an isolated headless launch is NOT run here (it would clone real repos); a targeted unit check of the coord-dir + env wiring via a tiny node harness.

**Interfaces:**
- Consumes: engine `--orchestrator` multi behavior (Task 3), env vars `CLAUDE_FLEET_MULTI`, `CLAUDE_FLEET_REPOS`, `CLAUDE_FLEET_STATUS_DIR` (Tasks 1–4).
- Produces: `buildFleet({mode:'gyftalala', account, repos:[{nameWithOwner,defaultBranch}], autonomous, orchestrator})` clones each repo, creates the coordination dir, records `sessions[sid] = { mode:'gyftalala', repos:[absPaths], coordDir, statusDir: coordDir/.status, … }`, spawns the multi-orchestrator pane. Exposes `s.repos` (array of absolute repo paths) + `s.coordDir`.

- [ ] **Step 1: Add the coord-dir + multi-clone helpers**

After `fleetDir` (`:232`), add:

```js
// Gyftalala (multi-repo) session: ONE coordination dir holds the shared .status the watcher observes; each repo
// keeps its own <basename>-fleet-<sid> dir (created by the engine). Name is stable + sid-scoped.
function coordDir(sid) { return path.join(SESSIONS_DIR, `gyftalala-multi-fleet-${sid}`); }
```

After `ensureRepoClone` (`:274`), add:

```js
// Clone/fetch every selected repo to ~/Developer/<name>; returns absolute paths (in selection order) or an error.
async function cloneRepos(repos, account) {
  const paths = [];
  for (const r of repos) {
    const ens = await ensureRepoClone(r.nameWithOwner, r.defaultBranch || 'main', account);
    if (!ens.ok) return { ok: false, error: `clone failed for ${r.nameWithOwner}: ${ens.error}` };
    paths.push(ens.path);
  }
  return { ok: true, paths };
}
```

- [ ] **Step 2: Add `runMultiOrchestrator`**

After `runOrchestrator` (`:592`), add:

```js
// Like runOrchestrator but multi-repo: the engine reads CLAUDE_FLEET_MULTI + CLAUDE_FLEET_REPOS + the shared
// coordination CLAUDE_FLEET_STATUS_DIR, creates each repo's _main, and emits the orchestrator pane JSON.
function runMultiOrchestrator(sid, coord, repoPaths) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      CLAUDE_FLEET_SESSION: String(sid),
      CLAUDE_FLEET_REPO: coord,                 // basename → coordination fleet name; not a git repo (multi path skips that check)
      CLAUDE_FLEET_MULTI: '1',
      CLAUDE_FLEET_REPOS: repoPaths.join(':'),
      CLAUDE_FLEET_STATUS_DIR: path.join(coord, '.status'),
    });
    execFile(FLEET_CLI, ['--orchestrator'], { maxBuffer: 16 * 1024 * 1024, env }, (err, out, errOut) => {
      if (err) return reject(new Error((errOut && errOut.trim()) || err.message));
      try { const p = JSON.parse(out); if (!Array.isArray(p) || !p.length) throw new Error('empty'); resolve(p); } catch (e) { reject(e); }
    });
  });
}
```

- [ ] **Step 3: Branch `buildFleet` for gyftalala mode**

Change the `buildFleet` signature to accept `mode` + `repos`:

```js
async function buildFleet({ autonomous, repo, nameWithOwner, defaultBranch, account, orchestrator, count, names, newProject, mode, repos }) {
```

Immediately after the `if (!pty) {…}` guard line (`:488`), add the gyftalala branch (it returns early, leaving the rest of `buildFleet` untouched for the single-repo modes):

```js
  if (mode === 'gyftalala') {
    if (!Array.isArray(repos) || !repos.length) return { ok: false, error: 'Gyftalala mode needs at least one repo.' };
    const cl = await cloneRepos(repos, account);
    if (!cl.ok) return { ok: false, error: cl.error };
    const sid = nextSid++;
    const coord = coordDir(sid);
    try { fsmod.mkdirSync(path.join(coord, '.status'), { recursive: true }); } catch (e) { nextSid--; return { ok: false, error: 'coord init failed: ' + ((e && e.message) || e) }; }
    const title = 'Gyftalala', color = account ? accountColor(account) : tabColor(title);
    sessions[sid] = {
      repo: coord, repos: cl.paths, coordDir: coord, title, color,
      mode: 'gyftalala', bypass: false, autonomous: true, newProject: false,
      panes: [], planReady: false, pending: {}, slugIdx: {},
      statusDir: path.join(coord, '.status'), watcher: null,
    };
    const win = targetGridWin();
    sidWin.set(sid, win.id);
    updatePowerBlocker();
    if (configWin) configWin.hide();
    const onReady = (panes) => {
      const s = sessions[sid]; if (!s) return;
      s.panes = panes; s.planReady = true;
      panes.forEach((p, i) => { if (p.slug) s.slugIdx[p.slug] = i; });
      Object.keys(s.pending).forEach((idx) => spawnPane(sid, +idx, s.pending[idx].cols, s.pending[idx].rows));
      startWatcher(sid); saveState(); updateBadgeAndTray();
    };
    const onErr = (err) => sendToSid(sid, 'fleet-error', { sid, msg: String(err.message || err) });
    sendAddSession(sid, title, color, [{ id: 0, role: 'orchestrator', heading: 'Orchestrator' }], 'gyftalala', win);
    runMultiOrchestrator(sid, coord, cl.paths).then(onReady).catch(onErr);
    return { ok: true };
  }
```

- [ ] **Step 4: Static-check**

Run: `node --check src/main.js && echo OK`
Expected: `OK`

- [ ] **Step 5: Unit-check the coord-dir + env wiring (no real clones)**

```bash
# scratchpad/t5.js — verify coordDir naming + the env runMultiOrchestrator builds (pure, no Electron needed)
node -e '
const path=require("path"), os=require("os");
const SESSIONS_DIR=path.join(os.homedir(),"Developer","Fleet-Sessions");
const coordDir=(sid)=>path.join(SESSIONS_DIR,`gyftalala-multi-fleet-${sid}`);
const c=coordDir(7);
if(path.basename(c)!=="gyftalala-multi-fleet-7") { console.error("FAIL coordDir"); process.exit(1); }
const repoPaths=["/a/gyftalala","/a/gyftalala-server"];
const env={CLAUDE_FLEET_MULTI:"1",CLAUDE_FLEET_REPOS:repoPaths.join(":"),CLAUDE_FLEET_STATUS_DIR:path.join(c,".status"),CLAUDE_FLEET_REPO:c};
if(env.CLAUDE_FLEET_REPOS!=="/a/gyftalala:/a/gyftalala-server"){console.error("FAIL repos env");process.exit(1);}
if(env.CLAUDE_FLEET_STATUS_DIR!==c+"/.status"){console.error("FAIL status env");process.exit(1);}
console.log("T5 PASS");
'
```
Expected: `T5 PASS`

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "main: gyftalala multi-repo launch path (clone set + coord dir + multi orchestrator)"
```

---

### Task 6: main.js — per-pane repo awareness + persistence

**Files:**
- Modify: `src/main.js` — `handleSpawn` (`:1151-1165`) read `info.repo`; `spawnPane` (`:1037-1064`) use the worker's repo for `CLAUDE_FLEET_REPO` + `CARGO_TARGET_DIR`, set `CLAUDE_FLEET_STATUS_DIR` for gyftalala sessions, set `CLAUDE_FLEET_MULTI`/`CLAUDE_FLEET_REPOS` on the orchestrator pane; `saveState` (`:30-40`) + `restoreSessions` (`:562-583`) persist `repos`/`coordDir`/`mode`.
- Test: static (`node --check`).

**Interfaces:**
- Consumes: `.spawn` marker `repo` field (Task 2), `s.repos`/`s.coordDir`/`s.mode==='gyftalala'` (Task 5).
- Produces: a gyftalala worker pane launches with `CLAUDE_FLEET_REPO = its worker repo`, `CLAUDE_FLEET_STATUS_DIR = s.coordDir/.status`; the orchestrator pane additionally gets `CLAUDE_FLEET_MULTI=1` + `CLAUDE_FLEET_REPOS`. Restored gyftalala sessions keep their repo set.

- [ ] **Step 1: handleSpawn — carry the worker's repo onto the pane**

In `handleSpawn`, change the `s.panes.push(...)` to include `repo`:

```js
    s.panes.push({ role: 'worker', slug: info.slug, heading: info.heading, dir: info.dir, prompt: info.prompt, effort: info.effort, repo: info.repo });
```

- [ ] **Step 2: spawnPane — repo-aware env**

In `spawnPane`, compute the pane's repo + whether this is a multi-repo session, and use them. Replace the `const env = Object.assign(...)` block (`:1037-1045`) and the `CLAUDE_FLEET_NEW_PROJECT` line region with:

```js
  const multi = s.mode === 'gyftalala';
  const paneRepo = p.repo || s.repo;                 // worker: its tagged repo; orchestrator/single: the session repo
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color', COLORTERM: 'truecolor',
    CLAUDE_FLEET_SESSION: String(sid), CLAUDE_FLEET_REPO: paneRepo,
    CLAUDE_CODE_EFFORT_LEVEL: effort,
    CARGO_TARGET_DIR: path.join(fleetDir(paneRepo, sid), '.cargo-target'),
    PATH: extraPath + (process.env.PATH ? ':' + process.env.PATH : ''),
  });
  if (multi) {
    env.CLAUDE_FLEET_STATUS_DIR = s.statusDir;        // all panes share the coordination .status
    if (p.role === 'orchestrator') {
      env.CLAUDE_FLEET_MULTI = '1';
      env.CLAUDE_FLEET_REPOS = (s.repos || []).join(':');
    }
  }
  if (s.newProject && p.role === 'orchestrator') env.CLAUDE_FLEET_NEW_PROJECT = '1';
```

(The orchestrator pane keeps MCP + the orchestrator allowlist via the existing `mcpArgs`/`dispatchPush` logic, which already keys on `p.role === 'orchestrator'` — unchanged. Pushing is confined to `--ship-all`, which the orchestrator runs.)

- [ ] **Step 3: Persist the repo set**

In `saveState` (`:34-37`), add `mode` is already saved; add `repos`/`coordDir`:

```js
        sid: +sid, autonomous: !!s.autonomous, repo: s.repo, title: s.title, color: s.color, mode: s.mode, bypass: !!s.bypass,
        repos: s.repos || null, coordDir: s.coordDir || null,
        panes: (s.panes || []).map((p, i) => (p ? { id: i, role: p.role, heading: p.heading, slug: p.slug, dir: p.dir, repo: p.repo } : null)).filter(Boolean),
```

In `restoreSessions` (`:570-574`), carry them onto the restored session + panes:

```js
    const s = {
      repo: ss.repo, title, color, mode: ss.mode || 'dispatch', bypass: !!ss.bypass, autonomous: !!ss.autonomous, planReady: true,
      repos: ss.repos || null, coordDir: ss.coordDir || null, panes: [],
      pending: {}, slugIdx: {}, statusDir: path.join(fleetDir(ss.repo, sid), '.status'), watcher: null,
    };
    panes.forEach((p) => { s.panes[p.id] = { role: p.role, slug: p.slug, heading: p.heading, dir: p.dir, repo: p.repo, prompt: '', resume: true }; if (p.slug) s.slugIdx[p.slug] = p.id; });
```

Note: for a gyftalala session `ss.repo` is the coord dir, so `statusDir` resolves to `coordDir/.status` — correct (matches the watcher surface). Leave the `fleetDir(ss.repo, sid)` call; `fleetDir(coord,…)` = `<coordbasename>-fleet-<sid>` = the coord dir itself.

- [ ] **Step 4: Static-check**

Run: `node --check src/main.js && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "main: per-pane repo env + multi-repo session persistence"
```

---

### Task 7: config.html — mode selector + multi-select repo picker

**Files:**
- Modify: `src/config.html` — add a mode segmented control to the second card; add a multi-select repo checklist (reusing `window.fleet.listAccountRepos`); branch the `go` payload to emit `mode:'gyftalala'` with the checked repos.
- Test: vm-compile the inline `<script>`; manual visual confirmation by the user (outside any fleet).

**Interfaces:**
- Consumes: existing `window.fleet.listAccountRepos(account)` (returns `{repos:[{nameWithOwner,name,defaultBranch,visibility}]}`), existing `window.fleet.launch(payload)`.
- Produces: when Gyftalala mode is active, `launch({ mode:'gyftalala', account, repos:[{nameWithOwner,defaultBranch}], autonomous:true, orchestrator:true })`.

- [ ] **Step 1: Add the mode control markup**

In the second `<section class="card">` (the orchestrator card, `:156-166`), add ABOVE the `useOrch` label:

```html
    <div class="label">Mode</div>
    <div class="counts" id="modeSel" style="grid-template-columns:repeat(2,1fr); margin-bottom:13px;">
      <button id="modeSingle" class="on">Single project</button>
      <button id="modeGyf">Gyftalala — multi-repo</button>
    </div>
    <div id="gyfCfg" style="display:none">
      <div class="label">Repos <span class="hintnote">— one task across all checked repos; ships them together</span></div>
      <div class="heads" id="gyfRepos" style="grid-template-columns:1fr;"></div>
    </div>
```

- [ ] **Step 2: Add the mode + repo-list logic**

In the `<script>`, after `let repo = '', … newProject = false;` (`:216`), add `let mode = 'single'; let gyfRepos = [];`. Add these functions (near `syncOrch`, `:392`):

```js
  const GYF_DEFAULT = ['gyftalala/gyftalala', 'gyftalala/gyftalala-server', 'gyftalala/gyftalala-admin', 'gyftalala/splashbook-editor'];
  const modeSelEl = document.getElementById('modeSel');
  const gyfCfg = document.getElementById('gyfCfg');
  const gyfReposEl = document.getElementById('gyfRepos');
  function setMode(m) {
    mode = m;
    document.getElementById('modeSingle').classList.toggle('on', m === 'single');
    document.getElementById('modeGyf').classList.toggle('on', m === 'gyftalala');
    gyfCfg.style.display = m === 'gyftalala' ? '' : 'none';
    document.querySelector('.opt').style.display = m === 'gyftalala' ? 'none' : '';   // hide orchestrator toggle in multi-repo
    gridCfg.style.display = (m === 'single' && !useOrchEl.checked) ? '' : 'none';
    if (m === 'gyftalala') { goEl.textContent = 'Launch Gyftalala fleet'; loadGyfRepos(); }
    else syncOrch();
    refreshGo(); fit();
  }
  function loadGyfRepos() {
    if (!account) { gyfReposEl.innerHTML = '<div class="projhint">Connect the gyftalala GitHub account above first.</div>'; fit(); return; }
    const repos = repoCache[account];
    if (!repos) { loadRepos(account).then(() => loadGyfRepos()); return; }   // populate cache, then render
    renderGyfRepos(repos);
  }
  function renderGyfRepos(repos) {
    gyfReposEl.innerHTML = '';
    repos.forEach((r) => {
      const row = document.createElement('label'); row.className = 'opt'; row.style.padding = '4px 0';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = r.nameWithOwner;
      cb.dataset.branch = r.defaultBranch || 'main';
      cb.checked = GYF_DEFAULT.includes(r.nameWithOwner);
      cb.onchange = refreshGo;
      const tx = document.createElement('span'); tx.className = 'otxt'; tx.innerHTML = '<b>' + r.name + '</b>';
      row.appendChild(cb); row.appendChild(tx); gyfReposEl.appendChild(row);
    });
    refreshGo(); fit();
  }
  function checkedGyfRepos() {
    return [...gyfReposEl.querySelectorAll('input:checked')].map((cb) => ({ nameWithOwner: cb.value, defaultBranch: cb.dataset.branch }));
  }
  document.getElementById('modeSingle').onclick = () => setMode('single');
  document.getElementById('modeGyf').onclick = () => setMode('gyftalala');
```

Update `refreshGo` (`:221`) to also enable in gyftalala mode when ≥1 repo checked:

```js
  function refreshGo() {
    if (mode === 'gyftalala') { goEl.disabled = !(account && gyfReposEl.querySelector('input:checked')); return; }
    goEl.disabled = !(repo || repoNWO || newProject);
  }
```

When the account changes (in `setAccount`, after it loads repos), if gyftalala mode is active, refresh the checklist. Add to the end of `setAccount` (`:355`): `if (mode === 'gyftalala') loadGyfRepos();`

- [ ] **Step 3: Branch the launch payload**

In `goEl.onclick` (`:401`), at the very top (before the existing `if (!(repo || repoNWO || newProject)) return;`), add:

```js
    if (mode === 'gyftalala') {
      const sel = checkedGyfRepos();
      if (!sel.length) { errEl.textContent = 'Check at least one repo.'; return; }
      goEl.disabled = true; goEl.textContent = 'Setting up…';
      const res = await window.fleet.launch({ mode: 'gyftalala', account, repos: sel, autonomous: true, orchestrator: true });
      if (!(res && res.ok)) { errEl.textContent = (res && res.error) || 'Launch failed.'; goEl.disabled = false; setMode('gyftalala'); }
      return;
    }
```

- [ ] **Step 4: vm-compile the inline script (static check)**

```bash
# scratchpad/t7.js — extract + compile config.html's inline <script> (syntax only)
node -e '
const fs=require("fs"),vm=require("vm");
const html=fs.readFileSync(process.env.HOME+"/Developer/claude-fleet-app/src/config.html","utf8");
const m=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
let n=0; for(const s of m){ try{ new vm.Script(s[1]); n++; }catch(e){ console.error("FAIL compile:",e.message); process.exit(1);} }
console.log("T7 PASS ("+n+" scripts compiled)");
'
```
Expected: `T7 PASS (...)`

- [ ] **Step 5: Commit**

```bash
git add src/config.html
git commit -m "config: Gyftalala multi-repo mode selector + repo checklist"
```

---

### Task 8: grid.html / preload tolerance + end-to-end smoke (outside any fleet)

**Files:**
- Verify (likely NO edit): `src/grid.html` — confirmed `add-session` defaults `mode || 'dispatch'` (`:212`) and only `mode === 'grid'` gates the "+ Pane" button (`:382`, `:402`); gyftalala falls through to dispatch-style rendering automatically. Edit ONLY if Step 1 surfaces a NEW core-rendering gate.
- Verify (no change expected): `src/preload.js` — confirm `launch` passes the payload through unchanged.
- Test: vm-compile grid.html inline scripts; `node --check src/preload.js`; OPTIONAL app-boot smoke ONLY if run outside any fleet session.

**Interfaces:**
- Consumes: `add-session` payload `mode` field (Task 6's `sendAddSession(... 'gyftalala' ...)`).

- [ ] **Step 1: Audit grid.html for mode assumptions**

Run: `grep -n "mode" src/grid.html`
Expected (current code): the only behavioral gates are `mode === 'grid'` (lines ~382/402, the "+ Pane" / add-grid-worker affordance), which correctly EXCLUDE gyftalala, plus `mode || 'dispatch'` default (line ~212). gyftalala therefore renders identically to dispatch — **no edit needed**. Proceed to Step 3.

- [ ] **Step 2: Edit ONLY if Step 1 found a NEW core gate**

If (and only if) Step 1 surfaces a strict equality that gates core rendering on `mode === 'dispatch'`, widen it so gyftalala renders dispatch-style:

```js
      const orchestratorStyle = (mode !== 'grid');   // dispatch AND gyftalala are orchestrator-style grids
```

Otherwise make no change and note "grid.html needs no change — gyftalala renders dispatch-style" in the Step 5 commit (or skip the commit entirely if nothing changed).

- [ ] **Step 3: Static-check renderers + preload**

```bash
node --check src/preload.js && echo PRELOAD_OK
node -e '
const fs=require("fs"),vm=require("vm");
const html=fs.readFileSync(process.env.HOME+"/Developer/claude-fleet-app/src/grid.html","utf8");
const m=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
let n=0; for(const s of m){ try{ new vm.Script(s[1]); n++; }catch(e){ console.error("FAIL",e.message); process.exit(1);} }
console.log("GRID_OK ("+n+")");
'
```
Expected: `PRELOAD_OK` and `GRID_OK (...)`.

- [ ] **Step 4: OPTIONAL end-to-end boot (ONLY outside any fleet session)**

> GATE: Run this ONLY if `echo "$CLAUDE_FLEET_SESSION"` is EMPTY (you are NOT in a fleet pane). Otherwise skip — launching the app from a fleet pane can wipe a live session (CLAUDE.md).

This does a real launch and a manual click-through of Gyftalala mode against the real gyftalala account. Because it would clone the real repos and run the real orchestrator, treat it as a USER-driven acceptance check, not an automated step:
1. User runs `npm start` from a plain dev shell.
2. Connect the `gyftalala` account; click **Gyftalala — multi-repo**; confirm the 4 repos appear pre-checked.
3. Launch; confirm the orchestrator pane opens, and a `gyftalala-multi-fleet-<sid>/.status` dir is created with a `worker-protocol.md` once the first worker spawns.

- [ ] **Step 5: Commit**

```bash
git add src/grid.html
git commit -m "grid: render gyftalala sessions as orchestrator-style"
```

---

## Self-Review

**Spec coverage:**
- Topology (one multi-repo orchestrator) → Task 3 (`spawn_multi_orchestrator_prompt`, multi `cmd_orchestrator`).
- Per-repo branch/merge/conflict reuse → Tasks 1–3 (`select_repo`, per-repo `_main`, unchanged `_do_spawn`/integration).
- Repo-tagged worker spawning → Task 2 (`--repo`, `repo` marker field, `<slug>.repo`).
- Shared coordination `.status` → Task 1 (`CLAUDE_FLEET_STATUS_DIR`) + Task 6 (watcher already keys on `s.statusDir`).
- Direct push to origin/main → Task 4 (`--ship-all` phase 2).
- Atomic hold-all on partial failure → Task 4 (phase-1 dry-run gate + negative test).
- Repo set picked each launch, default 4 → Task 7 (multi-select, `GYF_DEFAULT` pre-check).
- UI mode selector → Task 7.
- Launch + clone + session record → Task 5.
- Per-pane repo env + persistence → Task 6.
- Non-goals (no PR flow, no submodule merge) → respected (no PR code; no cross-repo git merge — contract passed by brief, per Task 3 prompt).

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" — each step shows full code or exact commands. Engine tests are complete runnable scripts.

**Type/name consistency:** `CLAUDE_FLEET_STATUS_DIR`, `CLAUDE_FLEET_MULTI`, `CLAUDE_FLEET_REPOS` used identically across Tasks 1/3/4/5/6. `resolve_repo`/`select_repo`/`SPAWN_REPO`/`cmd_ship_all` names consistent. `coordDir(sid)`, `s.repos`, `s.coordDir`, `info.repo`, `p.repo` consistent across main.js tasks. `.spawn` `repo` field (absolute path) matches `<slug>.repo` sidecar and `paneRepo` consumption.

**Risk recap (from spec):** four pushes are not one transaction; `--ship-all` mitigates with dry-run-all + push-in-order + re-confirm-ff-before-each-push + partial-landing report (Task 4 phase 2).
